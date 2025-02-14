import Serverless from 'serverless';
import prompt from 'prompt';
import _ from 'lodash';

import { Logging } from 'serverless/classes/Plugin';

import Logger from '../utils/logger';

import {
  getSentinelClient,
  getAutotaskClient,
  getAdminClient,
  getRelayClient,
  constructSentinel,
  constructNotification,
  getTeamAPIkeysOrThrow,
  getStackName,
  getResourceID,
  getEquivalentResource,
  isSSOT,
  getEquivalentResourceByKey,
  getConsolidatedSecrets,
  validateTypesAndSanitise,
  constructNotificationCategory,
  validateAdditionalPermissionsOrThrow,
  getDeploymentConfigClient,
  getBlockExplorerApiKeyClient,
} from '../utils';
import {
  DefenderAutotask,
  DefenderContract,
  DefenderNotification,
  DefenderRelayer,
  DefenderSentinel,
  DefenderRelayerApiKey,
  TeamKey,
  YAutotask,
  YContract,
  YNotification,
  YRelayer,
  YSecret,
  YSentinel,
  DeployOutput,
  DeployResponse,
  ResourceType,
  ListDefenderResources,
  DefenderNotificationReference,
  DefenderBlockSentinelResponse,
  DefenderFortaSentinelResponse,
  DefenderScheduleTrigger,
  DefenderWebhookTrigger,
  DefenderSentinelTrigger,
  DefenderMonitorFilterTrigger,
  DefenderDeploymentConfig,
  YDeploymentConfig,
  DefenderBlockExplorerApiKey,
  YBlockExplorerApiKey,
  DefenderCategory,
  YCategory,
} from '../types';
import keccak256 from 'keccak256';

export default class DefenderDeploy {
  serverless: Serverless;
  options: Serverless.Options;
  logging: Logging;
  log: Logger;
  hooks: any;
  teamKey?: TeamKey;
  ssotDifference?: ListDefenderResources;

  constructor(serverless: Serverless, options: Serverless.Options, logging: Logging) {
    this.serverless = serverless;
    this.options = options;
    this.logging = logging;

    this.log = Logger.getInstance();

    this.hooks = {
      'before:deploy:deploy': () => this.validateKeys(),
      'deploy:deploy': this.requestConfirmation.bind(this),
    };
  }

  validateKeys() {
    this.teamKey = getTeamAPIkeysOrThrow(this.serverless);
  }

  private async getSSOTDifference(): Promise<ListDefenderResources> {
    const difference: ListDefenderResources = {
      sentinels: [],
      autotasks: [],
      notifications: [],
      categories: [],
      contracts: [],
      relayerApiKeys: [],
      secrets: [],
      deploymentConfigs: [],
      blockExplorerApiKeys: [],
    };
    // Contracts
    const contracts: YContract[] = this.serverless.service.resources?.Resources?.contracts ?? [];
    const adminClient = getAdminClient(this.teamKey!);
    const dContracts = await adminClient.listContracts();
    const contractDifference = _.differenceWith(
      dContracts,
      Object.entries(contracts ?? []),
      (a: DefenderContract, b: [string, YContract]) =>
        `${a.network}-${a.address}` === `${b[1].network}-${b[1].address}`,
    );

    // Sentinels
    const sentinels: YSentinel[] = this.serverless.service.resources?.Resources?.sentinels ?? [];
    const sentinelClient = getSentinelClient(this.teamKey!);
    const dSentinels = (await sentinelClient.list()).items;
    const sentinelDifference = _.differenceWith(
      dSentinels,
      Object.entries(sentinels ?? []),
      (a: DefenderSentinel, b: [string, YSentinel]) =>
        a.stackResourceId === getResourceID(getStackName(this.serverless), b[0]),
    );

    // Relayers
    const relayers: YRelayer[] = this.serverless.service.resources?.Resources?.relayers ?? [];
    const relayerClient = getRelayClient(this.teamKey!);
    const dRelayers = (await relayerClient.list()).items;

    // Relayers API keys
    await Promise.all(
      Object.entries(relayers).map(async ([id, relayer]) => {
        const dRelayer = getEquivalentResourceByKey<DefenderRelayer>(
          getResourceID(getStackName(this.serverless), id),
          dRelayers,
        );
        if (dRelayer) {
          const dRelayerApiKeys = await relayerClient.listKeys(dRelayer.relayerId);
          const configuredKeys = relayer['api-keys'];
          const relayerApiKeyDifference = _.differenceWith(
            dRelayerApiKeys,
            configuredKeys,
            (a: DefenderRelayerApiKey, b: string) => a.stackResourceId === getResourceID(dRelayer.stackResourceId!, b),
          );
          difference.relayerApiKeys.push(...relayerApiKeyDifference);
        }
      }),
    );

    // Notifications
    const notifications: YNotification[] = this.serverless.service.resources?.Resources?.notifications ?? [];
    const dNotifications = await sentinelClient.listNotificationChannels();
    const notificationDifference = _.differenceWith(
      dNotifications,
      Object.entries(notifications ?? []),
      (a: DefenderNotification, b: [string, YNotification]) =>
        a.stackResourceId === getResourceID(getStackName(this.serverless), b[0]),
    );

    // Notification Categories
    const categories: YCategory[] = this.serverless.service.resources?.Resources?.categories ?? [];
    const dCategories = await sentinelClient.listNotificationCategories();
    const categoryDifference = _.differenceWith(
      dCategories,
      Object.entries(categories ?? []),
      (a: DefenderCategory, b: [string, YCategory]) =>
        a.stackResourceId === getResourceID(getStackName(this.serverless), b[0]),
    );

    // Autotasks
    const autotasks: YAutotask[] = this.serverless.service.functions as any;
    const autotaskClient = getAutotaskClient(this.teamKey!);
    const dAutotasks = (await autotaskClient.list()).items;
    const autotaskDifference = _.differenceWith(
      dAutotasks,
      Object.entries(autotasks ?? []),
      (a: DefenderAutotask, b: [string, YAutotask]) =>
        a.stackResourceId === getResourceID(getStackName(this.serverless), b[0]),
    );

    // Secrets
    const allSecrets = getConsolidatedSecrets(this.serverless);
    const dSecrets = (await autotaskClient.listSecrets()).secretNames ?? [];
    const secretsDifference = _.differenceWith(
      dSecrets,
      Object.values(allSecrets).map((k, _) => Object.keys(k)[0] ?? ''),
      (a: string, b: string) => a === b,
    );

    // Deployment Configs
    const deploymentConfigs: YDeploymentConfig[] =
      this.serverless.service.resources?.Resources?.['deployment-configs'] ?? [];
    const deploymentConfigClient = getDeploymentConfigClient(this.teamKey!);
    const dDeploymentConfigs = await deploymentConfigClient.list();
    const deploymentConfigDifference = _.differenceWith(
      dDeploymentConfigs,
      Object.entries(deploymentConfigs ?? []),
      (a: DefenderDeploymentConfig, b: [string, YDeploymentConfig]) =>
        a.stackResourceId === getResourceID(getStackName(this.serverless), b[0]),
    );

    // Block Explorer Api Keys
    const blockExplorerApiKeys: YBlockExplorerApiKey[] =
      this.serverless.service.resources?.Resources?.['block-explorer-api-keys'] ?? [];
    const blockExplorerApiKeysClient = getBlockExplorerApiKeyClient(this.teamKey!);
    const dBlockExplorerApiKeys = await blockExplorerApiKeysClient.list();
    const blockExplorerApiKeyDifference = _.differenceWith(
      dBlockExplorerApiKeys,
      Object.entries(blockExplorerApiKeys ?? []),
      (a: DefenderBlockExplorerApiKey, b: [string, YBlockExplorerApiKey]) =>
        a.stackResourceId === getResourceID(getStackName(this.serverless), b[0]),
    );

    difference.contracts = contractDifference;
    difference.sentinels = sentinelDifference;
    difference.notifications = notificationDifference;
    difference.categories = categoryDifference;
    difference.autotasks = autotaskDifference;
    difference.secrets = secretsDifference;
    difference.deploymentConfigs = deploymentConfigDifference;
    difference.blockExplorerApiKeys = blockExplorerApiKeyDifference;

    return difference;
  }
  private async constructConfirmationMessage(withResources: ListDefenderResources): Promise<string> {
    const start = `You have SSOT enabled. This might remove resources from Defender permanently.\nHaving SSOT enabled will interpret the resources defined in the serverless.yml file as the Single Source Of Truth, and will remove any existing Defender resource which is not defined in the YAML file (with the exception of Relayers).\nIf you continue, the following resources will be removed from Defender:`;
    const end = `Are you sure you wish to continue [y/n]?`;

    const formattedResources = {
      autotasks:
        withResources.autotasks.length > 0
          ? withResources.autotasks.map(a => `${a.stackResourceId ?? a.name} (${a.autotaskId})`)
          : undefined,
      sentinels:
        withResources.sentinels.length > 0
          ? withResources.sentinels.map(a => `${a.stackResourceId ?? a.name} (${a.subscriberId})`)
          : undefined,
      notifications:
        withResources.notifications.length > 0
          ? withResources.notifications.map(a => `${a.stackResourceId ?? a.name} (${a.notificationId})`)
          : undefined,
      contracts:
        withResources.contracts.length > 0
          ? withResources.contracts.map(a => `${a.network}-${a.address} (${a.name})`)
          : undefined,
      relayerApiKeys:
        withResources.relayerApiKeys.length > 0
          ? withResources.relayerApiKeys.map(a => `${a.stackResourceId ?? a.apiKey} (${a.keyId})`)
          : undefined,
      secrets: withResources.secrets.length > 0 ? withResources.secrets.map(a => `${a}`) : undefined,
    };
    return `${start}\n${
      _.isEmpty(validateTypesAndSanitise(formattedResources))
        ? 'None. No differences found.'
        : JSON.stringify(formattedResources, null, 2)
    }\n\n${end}`;
  }

  private async requestConfirmation() {
    if (isSSOT(this.serverless) && process.stdout.isTTY) {
      const properties = [
        {
          name: 'confirm',
          validator: /^(y|n){1}$/i,
          warning: 'Confirmation must be `y` (yes) or `n` (no)',
        },
      ];

      this.log.progress('component-deploy', `Retrieving list of resources`);

      this.ssotDifference = await this.getSSOTDifference();

      this.log.progress('component-deploy', `Awaiting confirmation from user`);
      prompt.start({
        message: await this.constructConfirmationMessage(this.ssotDifference),
      });
      const { confirm } = await prompt.get(properties);

      if (confirm!.toString().toLowerCase() !== 'y') {
        this.log.error('Confirmation not acquired. Terminating command');
        return;
      }
      this.log.success('Confirmation acquired');
    }

    await this.deploy();
  }

  private async deploySecrets(output: DeployOutput<string>) {
    const allSecrets = getConsolidatedSecrets(this.serverless);
    const client = getAutotaskClient(this.teamKey!);
    const retrieveExisting = () => client.listSecrets().then(r => r.secretNames ?? []);
    await this.wrapper<YSecret, string>(
      this.serverless,
      'Secrets',
      allSecrets,
      retrieveExisting,
      // on update
      async (secret: YSecret, match: string) => {
        await client.createSecrets({
          deletes: [],
          secrets: secret as any,
        });
        return {
          name: `Secret`,
          id: `${match}`,
          success: true,
          response: secret,
        };
      },
      // on create
      async (secret: YSecret, _: string) => {
        await client.createSecrets({
          deletes: [],
          secrets: secret as any,
        });
        return {
          name: `Secret`,
          id: `${Object.keys(secret)[0]}`,
          success: true,
          response: secret,
        };
      },
      // on remove
      async (secrets: string[]) => {
        await client.createSecrets({
          deletes: secrets,
          secrets: {},
        });
      },
      // overrideMatchDefinition
      (a: string, b: YSecret) => !!b[a],
      output,
      this.ssotDifference?.secrets,
    );
  }

  private async deployContracts(output: DeployOutput<DefenderContract>) {
    const contracts: YContract[] = this.serverless.service.resources?.Resources?.contracts ?? [];
    const client = getAdminClient(this.teamKey!);
    const retrieveExisting = () => client.listContracts();

    await this.wrapper<YContract, DefenderContract>(
      this.serverless,
      'Contracts',
      contracts,
      retrieveExisting,
      // on update
      async (contract: YContract, match: DefenderContract) => {
        const mappedMatch = {
          name: match.name,
          network: match.network,
          address: match.address,
          abi: match.abi && JSON.stringify(JSON.parse(match.abi)),
          'nat-spec': match.natSpec ? match.natSpec : undefined,
        };

        // in reality this will never be called as long as defender-client does not return ABI as part of the list response
        if (_.isEqual(validateTypesAndSanitise(contract), validateTypesAndSanitise(mappedMatch))) {
          return {
            name: match.name,
            id: `${match.network}-${match.address}`,
            success: false,
            response: match,
            notice: `Skipped import - contract ${match.address} already exists on ${match.network}`,
          };
        }

        this.log.notice(
          `Contracts will always update regardless of changes due to certain limitations in Defender API clients.`,
        );

        const updatedContract = await client.addContract({
          name: contract.name,
          network: match.network,
          address: match.address,
          abi: contract.abi && JSON.stringify(JSON.parse(contract.abi)),
          natSpec: contract['nat-spec'] ? contract['nat-spec'] : undefined,
        });

        return {
          name: updatedContract.name,
          id: `${match.network}-${match.address}`,
          success: true,
          response: updatedContract,
        };
      },
      // on create
      async (contract: YContract, _: string) => {
        const importedContract = await client.addContract({
          name: contract.name,
          network: contract.network,
          address: contract.address,
          abi: contract.abi && JSON.stringify(JSON.parse(contract.abi)),
          natSpec: contract['nat-spec'] ? contract['nat-spec'] : undefined,
        });
        return {
          name: importedContract.name,
          id: `${importedContract.network}-${importedContract.address}`,
          success: true,
          response: importedContract,
        };
      },
      // on remove
      async (contracts: DefenderContract[]) => {
        await Promise.all(contracts.map(async c => await client.deleteContract(`${c.network}-${c.address}`)));
      },
      // overrideMatchDefinition
      (a: DefenderContract, b: YContract) => {
        return a.address === b.address && a.network === b.network;
      },
      output,
      this.ssotDifference?.contracts,
    );
  }

  private async deployRelayers(
    output: DeployOutput<DefenderRelayer> & {
      relayerKeys: DeployOutput<DefenderRelayerApiKey>;
    },
  ) {
    const relayers: YRelayer[] = this.serverless.service.resources?.Resources?.relayers ?? [];
    const client = getRelayClient(this.teamKey!);
    const retrieveExisting = () => client.list().then(r => r.items);
    await this.wrapper<YRelayer, DefenderRelayer>(
      this.serverless,
      'Relayers',
      relayers,
      retrieveExisting,
      // on update
      async (relayer: YRelayer, match: DefenderRelayer) => {
        // Warn users when they try to change the relayer network
        if (match.network !== relayer.network) {
          this.log.warn(
            `Detected a network change from ${match.network} to ${relayer.network} for Relayer: ${match.stackResourceId}. Defender does not currently allow updates to the network once a Relayer is created. This change will be ignored. To enforce this change, remove this relayer and create a new one. Alternatively, you can change the unique identifier (stack resource ID), to force a new creation of the relayer. Note that this change might cause errors further in the deployment process for resources that have any dependencies to this relayer.`,
          );
          relayer.network = match.network!;
        }

        const mappedMatch = {
          name: match.name,
          network: match.network,
          'min-balance': parseInt(match.minBalance.toString()),
          policy: {
            'gas-price-cap': match.policies.gasPriceCap,
            'whitelist-receivers': match.policies.whitelistReceivers,
            'eip1559-pricing': match.policies.EIP1559Pricing,
            'private-transactions': match.policies.privateTransactions,
          },
          // currently not supported by defender-client
          // paused: match.paused
        };
        let updatedRelayer = undefined;
        if (
          !_.isEqual(
            validateTypesAndSanitise(_.omit(relayer, ['api-keys', 'address-from-relayer'])),
            validateTypesAndSanitise(mappedMatch),
          )
        ) {
          updatedRelayer = await client.update(match.relayerId, {
            name: relayer.name,
            minBalance: relayer['min-balance'],
            policies: relayer.policy && {
              whitelistReceivers: relayer.policy['whitelist-receivers'],
              gasPriceCap: relayer.policy['gas-price-cap'],
              EIP1559Pricing: relayer.policy['eip1559-pricing'],
              privateTransactions: relayer.policy['private-transactions'],
            },
          });
        }

        // check existing keys and remove / create accordingly
        const existingRelayerKeys = await client.listKeys(match.relayerId);
        const configuredKeys = relayer['api-keys'];
        const inDefender = _.differenceWith(
          existingRelayerKeys,
          configuredKeys,
          (a: DefenderRelayerApiKey, b: string) => a.stackResourceId === getResourceID(match.stackResourceId!, b),
        );

        // delete key in Defender thats not defined in template
        if (isSSOT(this.serverless) && inDefender.length > 0) {
          this.log.info(`Unused resources found on Defender:`);
          this.log.info(JSON.stringify(inDefender, null, 2));
          this.log.progress('component-deploy-extra', `Removing resources from Defender`);
          await Promise.all(inDefender.map(async key => await client.deleteKey(match.relayerId, key.keyId)));
          this.log.success(`Removed resources from Defender`);
          output.relayerKeys.removed.push(...inDefender);
        }

        const inTemplate = _.differenceWith(
          configuredKeys,
          existingRelayerKeys,
          (a: string, b: DefenderRelayerApiKey) => getResourceID(match.stackResourceId!, a) === b.stackResourceId,
        );

        // create key in Defender thats defined in template
        if (inTemplate) {
          await Promise.all(
            inTemplate.map(async key => {
              const keyStackResource = getResourceID(match.stackResourceId!, key);
              const createdKey = await client.createKey(match.relayerId, keyStackResource);
              this.log.success(`Created API Key (${keyStackResource}) for Relayer (${match.relayerId})`);
              const keyPath = `${process.cwd()}/.defender/relayer-keys/${keyStackResource}.json`;
              await this.serverless.utils.writeFile(keyPath, JSON.stringify({ ...createdKey }, null, 2));
              this.log.info(`API Key details stored in ${keyPath}`, 1);
              output.relayerKeys.created.push(createdKey);
            }),
          );
        }

        return {
          name: match.stackResourceId!,
          id: match.relayerId,
          success: !!updatedRelayer,
          response: updatedRelayer ?? match,
          notice: !updatedRelayer ? `Skipped ${match.stackResourceId} - no changes detected` : undefined,
        };
      },
      // on create
      async (relayer: YRelayer, stackResourceId: string) => {
        const relayers: YRelayer[] = this.serverless.service.resources?.Resources?.relayers ?? [];
        const existingRelayers = (await getRelayClient(this.teamKey!).list()).items;
        const maybeRelayer = getEquivalentResource<YRelayer | undefined, DefenderRelayer>(
          this.serverless,
          relayer['address-from-relayer'],
          relayers,
          existingRelayers,
        );

        const createdRelayer = await client.create({
          name: relayer.name,
          network: relayer.network,
          minBalance: relayer['min-balance'],
          useAddressFromRelayerId: maybeRelayer?.relayerId,
          policies: relayer.policy && {
            whitelistReceivers: relayer.policy['whitelist-receivers'],
            gasPriceCap: relayer.policy['gas-price-cap'],
            EIP1559Pricing: relayer.policy['eip1559-pricing'],
            privateTransactions: relayer.policy['private-transactions'],
          },
          stackResourceId,
        });

        const relayerKeys = relayer['api-keys'];
        if (relayerKeys) {
          await Promise.all(
            relayerKeys.map(async key => {
              const keyStackResource = getResourceID(stackResourceId, key);
              const createdKey = await client.createKey(createdRelayer.relayerId, keyStackResource);
              this.log.success(`Created API Key (${keyStackResource}) for Relayer (${createdRelayer.relayerId})`);
              const keyPath = `${process.cwd()}/.defender/relayer-keys/${keyStackResource}.json`;
              await this.serverless.utils.writeFile(keyPath, JSON.stringify({ ...createdKey }, null, 2));
              this.log.info(`API Key details stored in ${keyPath}`, 1);
              output.relayerKeys.created.push(createdKey);
            }),
          );
        }

        return {
          name: stackResourceId,
          id: createdRelayer.relayerId,
          success: true,
          response: createdRelayer,
        };
      },
      // on remove requires manual interaction
      undefined,
      undefined,
      output,
    );
  }

  private async deployNotifications(output: DeployOutput<DefenderNotification>) {
    const notifications: YNotification[] = this.serverless.service.resources?.Resources?.notifications ?? [];
    const client = getSentinelClient(this.teamKey!);
    const retrieveExisting = () => client.listNotificationChannels();

    await this.wrapper<YNotification, DefenderNotification>(
      this.serverless,
      'Notifications',
      notifications,
      retrieveExisting,
      // on update
      async (notification: YNotification, match: DefenderNotification) => {
        const mappedMatch = {
          type: match.type,
          name: match.name,
          config: match.config,
          paused: match.paused,
        };
        if (_.isEqual(validateTypesAndSanitise(notification), validateTypesAndSanitise(mappedMatch))) {
          return {
            name: match.stackResourceId!,
            id: match.notificationId,
            success: false,
            response: match,
            notice: `Skipped ${match.stackResourceId} - no changes detected`,
          };
        }

        const updatedNotification = await client.updateNotificationChannel({
          ...constructNotification(notification, match.stackResourceId!),
          notificationId: match.notificationId,
        });
        return {
          name: updatedNotification.stackResourceId!,
          id: updatedNotification.notificationId,
          success: true,
          response: updatedNotification,
        };
      },
      // on create
      async (notification: YNotification, stackResourceId: string) => {
        const createdNotification = await client.createNotificationChannel(
          constructNotification(notification, stackResourceId),
        );
        return {
          name: stackResourceId,
          id: createdNotification.notificationId,
          success: true,
          response: createdNotification,
        };
      },
      // on remove
      async (notifications: DefenderNotification[]) => {
        await Promise.all(notifications.map(async n => await client.deleteNotificationChannel(n)));
      },
      undefined,
      output,
      this.ssotDifference?.notifications,
    );
  }

  private async deployCategories(output: DeployOutput<DefenderCategory>) {
    const categories: YCategory[] = this.serverless.service.resources?.Resources?.categories ?? [];
    const client = getSentinelClient(this.teamKey!);
    const notifications = await client.listNotificationChannels();
    const retrieveExisting = () => client.listNotificationCategories();

    await this.wrapper<YCategory, DefenderCategory>(
      this.serverless,
      'Categories',
      categories,
      retrieveExisting,
      // on update
      async (category: YCategory, match: DefenderCategory) => {
        const newCategory = constructNotificationCategory(
          this.serverless,
          category,
          match.stackResourceId!,
          notifications,
        );
        const mappedMatch = {
          name: match.name,
          description: match.description,
          notificationIds: match.notificationIds,
          stackResourceId: match.stackResourceId,
        };
        if (_.isEqual(validateTypesAndSanitise(newCategory), validateTypesAndSanitise(mappedMatch))) {
          return {
            name: match.stackResourceId!,
            id: match.categoryId,
            success: false,
            response: match,
            notice: `Skipped ${match.stackResourceId} - no changes detected`,
          };
        }

        const updatedCategory = await client.updateNotificationCategory({
          ...newCategory,
          categoryId: match.categoryId,
        });
        return {
          name: updatedCategory.stackResourceId!,
          id: updatedCategory.categoryId,
          success: true,
          response: updatedCategory,
        };
      },
      // on create
      async (category: YCategory, stackResourceId: string) => {
        return {
          name: stackResourceId,
          id: '',
          success: false,
          notice: 'Creating custom notification categories is not yet supported',
        };
        // const createdCategory = await client.createNotificationCategory(
        //   constructNotificationCategory(this.serverless, category, stackResourceId, notifications),
        // );
        // return {
        //   name: stackResourceId,
        //   id: createdCategory.categoryId,
        //   success: true,
        //   response: createdCategory,
        // };
      },
      // on remove
      async (categories: DefenderCategory[]) => {
        this.log.warn(`Deleting notification categories is not yet supported.`);
        // await Promise.all(categories.map(async (n) => await client.deleteNotificationCategory(n.categoryId)));
      },
      // overrideMatchDefinition
      // TODO: remove this when we allow creating new categories
      (a: DefenderCategory, b: YCategory) => {
        return a.name === b.name;
      },
      output,
      this.ssotDifference?.categories,
    );
  }

  private async deploySentinels(output: DeployOutput<DefenderSentinel>) {
    try {
      const sentinels: YSentinel[] = this.serverless.service.resources?.Resources?.sentinels ?? [];
      const client = getSentinelClient(this.teamKey!);
      const autotasks = await getAutotaskClient(this.teamKey!).list();
      const notifications = await client.listNotificationChannels();
      const categories = await client.listNotificationCategories();
      const retrieveExisting = () => client.list().then(r => r.items);

      await this.wrapper<YSentinel, DefenderSentinel>(
        this.serverless,
        'Sentinels',
        sentinels,
        retrieveExisting,
        // on update
        async (sentinel: YSentinel, match: DefenderSentinel) => {
          const isForta = (o: DefenderSentinel): o is DefenderFortaSentinelResponse => o.type === 'FORTA';
          const isBlock = (o: DefenderSentinel): o is DefenderBlockSentinelResponse => o.type === 'BLOCK';

          // Warn users when they try to change the sentinel network
          if (match.network !== sentinel.network) {
            this.log.warn(
              `Detected a network change from ${match.network} to ${sentinel.network} for Sentinel: ${match.stackResourceId}. Defender does not currently allow updates to the network once a Sentinel is created. This change will be ignored. To enforce this change, remove this sentinel and create a new one. Alternatively, you can change the unique identifier (stack resource ID), to force a new creation of the sentinel. Note that this change might cause errors further in the deployment process for resources that have any dependencies to this sentinel.`,
            );
            sentinel.network = match.network!;
          }

          // Warn users when they try to change the sentinel type
          if (sentinel.type !== match.type) {
            this.log.warn(
              `Detected a type change from ${match.type} to ${sentinel.type} for Sentinel: ${match.stackResourceId}. Defender does not currently allow updates to the type once a Sentinel is created. This change will be ignored. To enforce this change, remove this sentinel and create a new one. Alternatively, you can change the unique identifier (stack resource ID), to force a new creation of the sentinel. Note that this change might cause errors further in the deployment process for resources that have any dependencies to this sentinel.`,
            );
            sentinel.type = match.type;
          }

          const blockwatchersForNetwork = (await client.listBlockwatchers()).filter(
            b => b.network === sentinel.network,
          );

          const newSentinel = constructSentinel(
            this.serverless,
            match.stackResourceId!,
            sentinel,
            notifications,
            autotasks.items,
            blockwatchersForNetwork,
            categories,
          );

          // Map match "response" object to that of a "create" object
          const addressRule =
            (isBlock(match) && match.addressRules.length > 0 && _.first(match.addressRules)) || undefined;
          const blockConditions =
            (addressRule && addressRule.conditions.length > 0 && addressRule.conditions) || undefined;
          const confirmLevel =
            (isBlock(match) && match.blockWatcherId.split('-').length > 0 && _.last(match.blockWatcherId.split('-'))) ||
            undefined;

          const mappedMatch = {
            name: match.name,
            abi: addressRule && addressRule.abi,
            paused: match.paused,
            alertThreshold: match.alertThreshold,
            autotaskTrigger: match.notifyConfig?.autotaskId,
            alertTimeoutMs: match.notifyConfig?.timeoutMs,
            alertMessageBody: match.notifyConfig?.messageBody,
            alertMessageSubject: match.notifyConfig?.messageSubject,
            notificationChannels: match.notifyConfig?.notifications.map(
              (n: DefenderNotificationReference) => n.notificationId,
            ),
            notificationCategoryId: _.isEmpty(match.notifyConfig?.notifications)
              ? match.notifyConfig?.notificationCategoryId
              : undefined,
            type: match.type,
            stackResourceId: match.stackResourceId,
            network: match.network,
            confirmLevel: (confirmLevel && parseInt(confirmLevel)) || confirmLevel,
            eventConditions: blockConditions && blockConditions.flatMap((c: any) => c.eventConditions),
            functionConditions: blockConditions && blockConditions.flatMap((c: any) => c.functionConditions),
            txCondition:
              blockConditions &&
              blockConditions[0]!.txConditions.length > 0 &&
              blockConditions[0]!.txConditions[0]!.expression,
            privateFortaNodeId: (isForta(match) && match.privateFortaNodeId) || undefined,
            addresses: isBlock(match) ? addressRule && addressRule.addresses : match.fortaRule?.addresses,
            autotaskCondition: isBlock(match)
              ? addressRule && addressRule.autotaskCondition?.autotaskId
              : match.fortaRule?.autotaskCondition?.autotaskId,
            fortaLastProcessedTime: (isForta(match) && match.fortaLastProcessedTime) || undefined,
            agentIDs: (isForta(match) && match.fortaRule?.agentIDs) || undefined,
            fortaConditions: (isForta(match) && match.fortaRule.conditions) || undefined,
            riskCategory: match.riskCategory,
          };

          if (_.isEqual(validateTypesAndSanitise(newSentinel), validateTypesAndSanitise(mappedMatch))) {
            return {
              name: match.stackResourceId!,
              id: match.subscriberId,
              success: false,
              response: match,
              notice: `Skipped ${match.stackResourceId} - no changes detected`,
            };
          }

          const updatedSentinel = await client.update(
            match.subscriberId,
            // Do not allow to update network of (existing) sentinels
            _.omit(newSentinel, ['network']),
          );

          return {
            name: updatedSentinel.stackResourceId!,
            id: updatedSentinel.subscriberId,
            success: true,
            response: updatedSentinel,
          };
        },
        // on create
        async (sentinel: YSentinel, stackResourceId: string) => {
          const blockwatchersForNetwork = (await client.listBlockwatchers()).filter(
            b => b.network === sentinel.network,
          );
          const createdSentinel = await client.create(
            constructSentinel(
              this.serverless,
              stackResourceId,
              sentinel,
              notifications,
              autotasks.items,
              blockwatchersForNetwork,
              categories,
            ),
          );
          return {
            name: stackResourceId,
            id: createdSentinel.subscriberId,
            success: true,
            response: createdSentinel,
          };
        },
        // on remove
        async (sentinels: DefenderSentinel[]) => {
          await Promise.all(sentinels.map(async s => await client.delete(s.subscriberId)));
        },
        undefined,
        output,
        this.ssotDifference?.sentinels,
      );
    } catch (e) {
      this.log.tryLogDefenderError(e);
    }
  }

  private async deployAutotasks(output: DeployOutput<DefenderAutotask>) {
    const autotasks: YAutotask[] = this.serverless.service.functions as any;
    const client = getAutotaskClient(this.teamKey!);
    const retrieveExisting = () => client.list().then(r => r.items);

    await this.wrapper<YAutotask, DefenderAutotask>(
      this.serverless,
      'Autotasks',
      autotasks,
      retrieveExisting,
      // on update
      async (autotask: YAutotask, match: DefenderAutotask) => {
        const relayers: YRelayer[] = this.serverless.service.resources?.Resources?.relayers ?? [];
        const existingRelayers = (await getRelayClient(this.teamKey!).list()).items;
        const maybeRelayer = getEquivalentResource<YRelayer | undefined, DefenderRelayer>(
          this.serverless,
          autotask.relayer,
          relayers,
          existingRelayers,
        );
        // Get new code digest
        const code = await client.getEncodedZippedCodeFromFolder(autotask.path);
        const newDigest = client.getCodeDigest(code);
        const { codeDigest } = await client.get(match.autotaskId);

        const isSchedule = (
          o: DefenderWebhookTrigger | DefenderScheduleTrigger | DefenderSentinelTrigger | DefenderMonitorFilterTrigger,
        ): o is DefenderScheduleTrigger => o.type === 'schedule';

        const mappedMatch = {
          name: match.name,
          trigger: {
            type: match.trigger.type,
            frequency: (isSchedule(match.trigger) && match.trigger.frequencyMinutes) || undefined,
            cron: (isSchedule(match.trigger) && match.trigger.cron) || undefined,
          },
          paused: match.paused,
          relayerId: match.relayerId,
          codeDigest: match.codeDigest,
        };

        if (
          _.isEqual(
            validateTypesAndSanitise({
              ..._.omit(autotask, ['events', 'package', 'relayer', 'path']),
              relayerId: maybeRelayer?.relayerId,
              codeDigest: newDigest,
            }),
            validateTypesAndSanitise(mappedMatch),
          )
        ) {
          return {
            name: match.stackResourceId!,
            id: match.autotaskId,
            success: false,
            response: match,
            notice: `Skipped ${match.stackResourceId} - no changes detected`,
          };
        }

        const updatesAutotask = await client.update({
          autotaskId: match.autotaskId,
          name: autotask.name,
          paused: autotask.paused,
          trigger: {
            type: autotask.trigger.type,
            frequencyMinutes: autotask.trigger.frequency ?? undefined,
            cron: autotask.trigger.cron ?? undefined,
          },
          relayerId: maybeRelayer?.relayerId,
        });

        if (newDigest === codeDigest) {
          return {
            name: match.stackResourceId!,
            id: match.autotaskId,
            success: true,
            notice: `Skipped code upload - no changes detected for ${match.stackResourceId}`,
            response: updatesAutotask,
          };
        } else {
          await client.updateCodeFromFolder(match.autotaskId, autotask.path);
          return {
            name: match.stackResourceId!,
            id: match.autotaskId,
            success: true,
            response: updatesAutotask,
          };
        }
      },
      // on create
      async (autotask: YAutotask, stackResourceId: string) => {
        const autotaskRelayer = autotask.relayer;
        const relayers: YRelayer[] = this.serverless.service.resources?.Resources?.relayers ?? [];
        const existingRelayers = (await getRelayClient(this.teamKey!).list()).items;
        const maybeRelayer = getEquivalentResource<YRelayer | undefined, DefenderRelayer>(
          this.serverless,
          autotaskRelayer,
          relayers,
          existingRelayers,
        );

        const createdAutotask = await client.create({
          name: autotask.name,
          trigger: {
            type: autotask.trigger.type,
            frequencyMinutes: autotask.trigger.frequency ?? undefined,
            cron: autotask.trigger.cron ?? undefined,
          },
          encodedZippedCode: await client.getEncodedZippedCodeFromFolder(autotask.path),
          paused: autotask.paused,
          relayerId: maybeRelayer?.relayerId,
          stackResourceId: stackResourceId,
        });
        return {
          name: stackResourceId,
          id: createdAutotask.autotaskId,
          success: true,
          response: createdAutotask,
        };
      },
      // on remove
      async (autotasks: DefenderAutotask[]) => {
        await Promise.all(autotasks.map(async a => await client.delete(a.autotaskId)));
      },
      undefined,
      output,
      this.ssotDifference?.autotasks,
    );
  }

  private async deployDeploymentConfig(output: DeployOutput<DefenderDeploymentConfig>) {
    const deploymentConfigs: YDeploymentConfig[] =
      this.serverless.service.resources?.Resources?.['deployment-configs'] ?? [];
    const client = getDeploymentConfigClient(this.teamKey!);
    const retrieveExisting = () => client.list();

    await this.wrapper<YDeploymentConfig, DefenderDeploymentConfig>(
      this.serverless,
      'Deployment Configs',
      deploymentConfigs,
      retrieveExisting,
      // on update
      async (deploymentConfig: YDeploymentConfig, match: DefenderDeploymentConfig) => {
        const deploymentConfigRelayer = deploymentConfig.relayer;
        const relayers: YRelayer[] = this.serverless.service.resources?.Resources?.relayers ?? [];

        const existingRelayers = (await getRelayClient(this.teamKey!).list()).items;
        const maybeRelayer = getEquivalentResource<YRelayer | undefined, DefenderRelayer>(
          this.serverless,
          deploymentConfigRelayer,
          relayers,
          existingRelayers,
        );

        if (!maybeRelayer)
          throw new Error(`Cannot find relayer ${deploymentConfigRelayer} in ${match.stackResourceId!}`);

        if (_.isEqual(maybeRelayer.relayerId, match.relayerId)) {
          return {
            name: match.stackResourceId!,
            id: match.deploymentConfigId,
            success: false,
            response: match,
            notice: `Skipped ${match.stackResourceId} - no changes detected`,
          };
        }

        const updatedDeploymentConfig = await client.update(match.deploymentConfigId, {
          relayerId: maybeRelayer.relayerId,
          stackResourceId: match.stackResourceId!,
        });
        return {
          name: updatedDeploymentConfig.stackResourceId!,
          id: updatedDeploymentConfig.deploymentConfigId,
          success: true,
          response: updatedDeploymentConfig,
        };
      },
      // on create
      async (deploymentConfig: YDeploymentConfig, stackResourceId: string) => {
        const deploymentConfigRelayer = deploymentConfig.relayer;
        const relayers: YRelayer[] = this.serverless.service.resources?.Resources?.relayers ?? [];
        const existingRelayers = (await getRelayClient(this.teamKey!).list()).items;

        const maybeRelayer = getEquivalentResource<YRelayer | undefined, DefenderRelayer>(
          this.serverless,
          deploymentConfigRelayer,
          relayers,
          existingRelayers,
        );

        if (!maybeRelayer) throw new Error(`Cannot find relayer ${deploymentConfigRelayer} in ${stackResourceId}`);

        const importedDeployment = await client.create({ relayerId: maybeRelayer.relayerId, stackResourceId });

        return {
          name: stackResourceId,
          id: importedDeployment.deploymentConfigId,
          success: true,
          response: importedDeployment,
        };
      },
      // on remove
      async (deploymentConfigs: DefenderDeploymentConfig[]) => {
        await Promise.all(deploymentConfigs.map(async c => await client.remove(c.deploymentConfigId)));
      },
      undefined,
      output,
      this.ssotDifference?.deploymentConfigs,
    );
  }

  private async deployBlockExplorerApiKey(output: DeployOutput<DefenderBlockExplorerApiKey>) {
    const blockExplorerApiKeys: YBlockExplorerApiKey[] =
      this.serverless.service.resources?.Resources?.['block-explorer-api-keys'] ?? [];
    const client = getBlockExplorerApiKeyClient(this.teamKey!);
    const retrieveExisting = () => client.list();

    await this.wrapper<YBlockExplorerApiKey, DefenderBlockExplorerApiKey>(
      this.serverless,
      'Block Explorer Api Keys',
      blockExplorerApiKeys,
      retrieveExisting,
      // on update
      async (blockExplorerApiKey: YBlockExplorerApiKey, match: DefenderBlockExplorerApiKey) => {
        if (_.isEqual(keccak256(blockExplorerApiKey.key).toString('hex'), match.keyHash)) {
          return {
            name: match.stackResourceId!,
            id: match.blockExplorerApiKeyId,
            success: false,
            response: match,
            notice: `Skipped ${match.stackResourceId} - no changes detected`,
          };
        }

        const updatedBlockExplorerApiKey = await client.update(match.blockExplorerApiKeyId, {
          ...blockExplorerApiKey,
          stackResourceId: match.stackResourceId!,
        });
        return {
          name: updatedBlockExplorerApiKey.stackResourceId!,
          id: updatedBlockExplorerApiKey.blockExplorerApiKeyId,
          success: true,
          response: updatedBlockExplorerApiKey,
        };
      },
      // on create
      async (blockExplorerApiKey: YBlockExplorerApiKey, stackResourceId: string) => {
        const importedBlockExplorerApiKey = await client.create({ ...blockExplorerApiKey, stackResourceId });
        return {
          name: stackResourceId,
          id: importedBlockExplorerApiKey.blockExplorerApiKeyId,
          success: true,
          response: importedBlockExplorerApiKey,
        };
      },
      // on remove
      async (blockExplorerApiKeys: DefenderBlockExplorerApiKey[]) => {
        await Promise.all(blockExplorerApiKeys.map(async c => await client.remove(c.blockExplorerApiKeyId)));
      },
      undefined,
      output,
      this.ssotDifference?.blockExplorerApiKeys,
    );
  }

  private async wrapper<Y, D>(
    context: Serverless,
    resourceType: ResourceType,
    resources: Y[] | undefined,
    retrieveExistingResources: () => Promise<D[]>,
    onUpdate: (resource: Y, match: D) => Promise<DeployResponse>,
    onCreate: (resource: Y, stackResourceId: string) => Promise<DeployResponse>,
    onRemove?: (resources: D[]) => Promise<void>,
    overrideMatchDefinition?: (a: D, b: Y) => boolean,
    output: DeployOutput<any> = { removed: [], created: [], updated: [] },
    ssotDifference: D[] = [],
  ) {
    try {
      const stackName = getStackName(context);
      this.log.notice(`${resourceType}`);
      this.log.progress('component-deploy', `Validating permissions for ${resourceType}`);
      await validateAdditionalPermissionsOrThrow<Y>(context, resources, resourceType);
      this.log.progress('component-deploy', `Initialising deployment of ${resourceType}`);

      // only remove if template is considered single source of truth
      if (isSSOT(context) && onRemove) {
        if (ssotDifference.length > 0) {
          this.log.info(`Unused resources found on Defender:`);
          this.log.info(JSON.stringify(ssotDifference, null, 2));
          this.log.progress('component-deploy-extra', `Removing resources from Defender`);
          await onRemove(ssotDifference);
          this.log.success(`Removed resources from Defender`);
          output.removed.push(...ssotDifference);
        }
      }

      for (const [id, resource] of Object.entries(resources ?? [])) {
        // always refresh list after each addition as some resources rely on the previous one
        const existing = await retrieveExistingResources();
        const entryStackResourceId = getResourceID(stackName, id);
        let match;
        if (overrideMatchDefinition) {
          match = existing.find((e: D) => overrideMatchDefinition(e, resource));
        } else {
          match = existing.find((e: any) => e.stackResourceId === entryStackResourceId);
        }

        if (match) {
          this.log.progress(
            'component-deploy-extra',
            `Updating ${
              resourceType === 'Contracts'
                ? (match as unknown as DefenderContract).name
                : resourceType === 'Secrets'
                ? match
                : (match as D & { stackResourceId: string }).stackResourceId
            }`,
          );
          try {
            const result = await onUpdate(resource, match);
            if (result.success) {
              this.log.success(`Updated ${result.name} (${result.id})`);
              output.updated.push(result.response);
            }
            // notice logs requires the --verbose flag
            if (result.notice) this.log.info(`${result.notice}`, 1);
            if (result.error) this.log.error(`${result.error}`);
          } catch (e) {
            this.log.tryLogDefenderError(e);
          }
        } else {
          this.log.progress(
            'component-deploy-extra',
            `Creating ${
              resourceType === 'Secrets' ? Object.keys(resource as unknown as YSecret)[0] : entryStackResourceId
            }`,
          );
          try {
            const result = await onCreate(resource, entryStackResourceId);
            if (result.success) {
              this.log.success(`Created ${result.name} (${result.id})`);
              output.created.push(result.response);
            }
            if (result.notice) this.log.info(`${result.notice}`, 1);
            if (result.error) this.log.error(`${result.error}`);
          } catch (e) {
            this.log.tryLogDefenderError(e);
          }
        }
      }
    } catch (e) {
      this.log.tryLogDefenderError(e);
    }
  }

  public async deploy() {
    this.log.notice('========================================================');
    const stackName = getStackName(this.serverless);
    this.log.progress('deploy', `Running Defender Deploy on stack: ${stackName}`);

    const sentinels: DeployOutput<DefenderSentinel> = {
      removed: [],
      created: [],
      updated: [],
    };
    const autotasks: DeployOutput<DefenderAutotask> = {
      removed: [],
      created: [],
      updated: [],
    };
    const contracts: DeployOutput<DefenderContract> = {
      removed: [],
      created: [],
      updated: [],
    };
    const notifications: DeployOutput<DefenderNotification> = {
      removed: [],
      created: [],
      updated: [],
    };
    const categories: DeployOutput<DefenderCategory> = {
      removed: [],
      created: [],
      updated: [],
    };
    const secrets: DeployOutput<string> = {
      removed: [],
      created: [],
      updated: [],
    };
    const relayers: DeployOutput<DefenderRelayer> & {
      relayerKeys: DeployOutput<DefenderRelayerApiKey>;
    } = {
      removed: [],
      created: [],
      updated: [],
      relayerKeys: {
        removed: [],
        created: [],
        updated: [],
      },
    };

    const deploymentConfigs: DeployOutput<DefenderDeploymentConfig> = {
      removed: [],
      created: [],
      updated: [],
    };

    const blockExplorerApiKeys: DeployOutput<DefenderBlockExplorerApiKey> = {
      removed: [],
      created: [],
      updated: [],
    };

    const stdOut = {
      stack: stackName,
      timestamp: new Date().toISOString(),
      sentinels,
      autotasks,
      contracts,
      relayers,
      notifications,
      categories,
      secrets,
      deploymentConfigs,
      blockExplorerApiKeys,
    };
    await this.deploySecrets(stdOut.secrets);
    await this.deployContracts(stdOut.contracts);
    // Always deploy relayers before autotasks
    await this.deployRelayers(stdOut.relayers);
    await this.deployAutotasks(stdOut.autotasks);
    // Deploy notifications before sentinels and categories
    await this.deployNotifications(stdOut.notifications);
    await this.deployCategories(stdOut.categories);
    await this.deploySentinels(stdOut.sentinels);

    await this.deployDeploymentConfig(stdOut.deploymentConfigs);
    await this.deployBlockExplorerApiKey(stdOut.blockExplorerApiKeys);

    this.log.notice('========================================================');

    if (!process.stdout.isTTY) this.log.stdOut(JSON.stringify(stdOut, null, 2));

    const keyDir = `${process.cwd()}/.defender`;
    if (!this.serverless.utils.dirExistsSync(keyDir)) {
      await this.serverless.utils.writeFile(
        `${keyDir}/deployment-log.${stackName}.json`,
        JSON.stringify(stdOut, null, 0) + '\r\n',
      );
    } else {
      await this.serverless.utils.appendFileSync(
        `${keyDir}/deployment-log.${stackName}.json`,
        JSON.stringify(stdOut, null, 0) + '\r\n',
      );
    }
  }
}
