# Defender Serverless Plugin

Defender Serverless is a Serverless Framework plugin for automated resource management on Defender.

:warning: **This plugin is still under development. Bugs are expected. Use with care.**

## Prerequisites

Serverless Framework: https://www.serverless.com/framework/docs/getting-started/

## Installation

You can initialise your Serverless project directly using our pre-configured template:

```
sls install --url https://github.com/OpenZeppelin/defender-serverless/tree/main/template -n my-service
```

Note: for the command above to work correctly you need access to this repo.

Alternatively, you can install it directly into an existing project with:

`yarn add defender-serverless`

## Setup

This plugin allows you to define Autotasks, Sentinels, Notifications, Relayers, Contracts, Policies and Secrets declaratively from a `serverless.yml` and provision them via the CLI using `serverless deploy`. An example template below with an autotask, a relayer, a policy and a single relayer API key defined:

```yaml
service: defender-serverless-template
configValidationMode: error
frameworkVersion: '3'

provider:
  name: defender
  stage: ${opt:stage, 'dev'}
  stackName: 'mystack'
  ssot: false

defender:
  key: '${env:TEAM_API_KEY}'
  secret: '${env:TEAM_API_SECRET}'

functions:
  autotask-example-1:
    name: 'Hello world from serverless'
    path: './autotasks/hello-world'
    relayer: ${self:resources.Resources.relayers.relayer-1}
    trigger:
      type: 'schedule'
      frequency: 1500
    paused: false

resources:
  Resources:
    policies:
      policy-1:
        gas-price-cap: 1000
        whitelist-receivers:
          - '0x0f06aB75c7DD497981b75CD82F6566e3a5CAd8f2'
        eip1559-pricing: true

    relayers:
      relayer-1:
        name: 'Test Relayer 1'
        network: 'goerli'
        min-balance: 1000
        policy: ${self:resources.Resources.policies.policy-1}
        api-keys:
          - key1

plugins:
  - defender-serverless
```

This requires setting the `key` and `secret` under the `defender` property of the YAML file. We recommend using environment variables or a secure (gitignored) configuration file to retrieve these values. Modify the `serverless.yml` accordingly.

Ensure the Defender Team API Keys are setup with all appropriate API capabilities.

The `stackName` (e.g. mystack) is combined with the resource key (e.g. relayer-1) to uniquely identify each resource. This identifier is called the `stackResourceId` (e.g. mystack.relayer-1) and allows you to manage multiple deployments within the same Defender team.

### SSOT mode

Under the `provider` property in the `serverless.yml` file, you can optionally add a `ssot` boolean. SSOT or Single Source of Truth, ensures that the state of your stack in Defender is perfectly in sync with the `serverless.yml` template.
This means that all Defender resources, that are not defined in your current template file, are removed from Defender, with the exception of Relayers, upon deployment. If SSOT is not defined in the template, it will default to `false`.

Any resource removed from the `serverless.yml` file does _not_ get automatically deleted in order to prevent inadvertent resource deletion. For this behaviour to be anticipated, SSOT mode must be enabled.

### Block Explorer Api Keys

Exported serverless configurations with Block Explorer Api Keys will not contain the `key` field but instead a `key-hash` field which is a keccak256 hash of the key. This must be replaced with the actual `key` field (and `key-hash` removed) before deploying

### Secrets (Autotask)

Autotask secrets can be defined both globally and per stack. Secrets defined under `global` are not affected by changes to the `stackName` and will retain when redeployed under a new stack. Secrets defined under `stack` will be removed (on the condition that [SSOT mode](#SSOT-mode) is enabled) when the stack is redeployed under a new `stackName`. To reference secrets defined under `stack`, use the following format: `<stackname>_<secretkey>`, for example `mystack_test`.

```yaml
secrets:
  # optional - global secrets are not affected by stackName changes
  global:
    foo: ${self:custom.config.secrets.foo}
    hello: ${self:custom.config.secrets.hello}
  # optional - stack secrets (formatted as <stackname>_<secretkey>)
  stack:
    test: ${self:custom.config.secrets.test}
```

### Types and Schema validation

We provide auto-generated documentation based on the JSON schemas:

- [Defender Property](https://github.com/OpenZeppelin/defender-serverless/blob/main/src/types/docs/defender.md)
- [Provider Property](https://github.com/OpenZeppelin/defender-serverless/blob/main/src/types/docs/provider.md)
- [Function (Autotask) Property](https://github.com/OpenZeppelin/defender-serverless/blob/main/src/types/docs/function.md)
- [Resources Property](https://github.com/OpenZeppelin/defender-serverless/blob/main/src/types/docs/resources.md)

More information on types can be found [here](https://github.com/OpenZeppelin/defender-serverless/blob/main/src/types/index.ts). Specifically, the types preceded with `Y` (e.g. YRelayer). For the schemas, you can check out the [docs-schema](https://github.com/OpenZeppelin/defender-serverless/blob/main/src/types/docs-schemas) folder.

Additionally, an [example project](https://github.com/OpenZeppelin/defender-serverless/blob/main/examples/defender-test-project/serverless.yml) is available which provides majority of properties that can be defined in the `serverless.yml` file.

## Commands

### Deploy

You can use `sls deploy` to deploy your current stack to Defender.

The deploy takes in an optional `--stage` flag, which is defaulted to `dev` when installed from the template above.

Moreover, the `serverless.yml` may contain an `ssot` property. More information can be found in the [SSOT mode](#SSOT-mode) section.

This command will append a log entry in the `.defender` folder of the current working directory. Additionally, if any new relayer keys are created, these will be stored as JSON objects in the `.defender/relayer-keys` folder.

> When installed from the template, we ensure the `.defender` folder is ignored from any git commits. However, when installing directly, make sure to add this folder it your `.gitignore` file.

### Info

You can use `sls info` to retrieve information on every resource defined in the `serverless.yml` file, including unique identifiers, and properties unique to each Defender component.

### Remove

You can use `sls remove` to remove all defender resources defined in the `serverless.yml` file.

> To avoid potential loss of funds, Relayers can only be deleted from the Defender UI directly.

### Logs

You can use `sls logs --function <stack_resource_id> --data {...}` to retrieve the latest autotask logs for a given autotask identifier (e.g. mystack.autotask-example-1). This command will run continiously and retrieve logs every 2 seconds. The `--data` flag is optional.

### Invoke

You can use `sls invoke --function <stack_resource_id>` to manually run an autotask, given its identifier (e.g. mystack.autotask-example-1).

> Each command has a standard output to a JSON object.

More information can be found on our documentation page [here](https://docs.openzeppelin.com/defender/serverless-plugin.html)

## Caveats

Note that when setting up the notification configuration for a sentinel, the `channels` property will always be prioritised over `category`. A notification category can only be associated to a sentinel with no linked notification channels. This means that the `channels` property should be assigned the value `[]` in order to prioritise the `category` property.

```yaml
notify-config:
  channels: [] # assign channels as empty list if you wish to use a category
  category: ${self:resources.Resources.categories.medium-severity} # optional
```

Errors thrown during the `deploy` process, will not revert any prior changes. Common errors are:

- Not having set the API key and secret
- Insufficient permissions for the API key
- Validation error of the `serverless.yml` file (see [Types and Schema validation](#Types-and-Schema-validation))

Usually, fixing the error and retrying the deploy should suffice as any existing resources will fall within the `update` clause of the deployment. However, if unsure, you can always call `sls remove` to remove the entire stack, and retry.

## Publish a new release

```bash
npm login
git checkout master
git pull origin master
yarn publish --no-git-tag-version
# enter new version at prompt
git add package.json
git commit -m 'v{version here}'
git push origin master
```
