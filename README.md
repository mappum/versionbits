# versionbits

[![npm version](https://img.shields.io/npm/v/versionbits.svg)](https://www.npmjs.com/package/versionbits)
[![Build Status](https://travis-ci.org/mappum/versionbits.svg?branch=master)](https://travis-ci.org/mappum/versionbits)
[![Dependency Status](https://david-dm.org/mappum/versionbits.svg)](https://david-dm.org/mappum/versionbits)

**Track Bitcoin versionbits deployments (BIP9)**

## Usage

`npm install versionbits`

```js
// import versionbits parameters for Bitcoin
var params = require('webcoin-bitcoin').versionbits

var VersionBits = require('versionbits')
var vbits = new VersionBits(params, db) // db is a LevelUp instance

// `chain` is a Blockchain instance from the `blockchain-spv` module
chain.createReadStream().pipe(vbits)
```

BIP9 is a specification that allows Bitcoin miners to use the `version` field in blocks as a bitfield in order to specify which soft-fork changes they support. Once a certain number of blocks have a certain bit set, the soft-fork change is activated and the new rules come into effect. This module checks the status of these soft-fork deployments.

----
#### `var vbits = new VersionBits(params, db)`

Creates a `VersionBits` instance which keeps track of the state of each versionbits deployment.

`params` should be the versionbits parameters for the blockchain you wish to use. Parameters for Bitcoin are available at `require('webcoin-bitcoin').versionbits`. For more info about params you can use, see the [Parameters](#parameters) section.

`db` should be a [`LevelUp`](https://github.com/Level/levelup) instance where state data will be stored. The db should not be shared.

----
#### `vbits.get(id)`

Returns the state of the deployment with the given `id` (e.g. `'csv'` or `'segwit'`).

----
#### `vbits.getDeployments()`

Returns an array of all deployments currently being tracked.

----
#### `vbits.getHash(cb)`

Calls `cb` with the hash of the most recently processed block. Use this to figure out which block to start streaming from when piping blocks from a [`blockchain-spv`](https://github.com/mappum/blockchain-spv) `Blockchain` into `vbits`.

#### **Event:** `status`

Emitted when the status of a deployment changes (e.g. when a deployment goes from `started` to `lockedIn`).

#### **Event:** `update`

Emitted whenever the state of a deployment changes (e.g. when the bit count is incremented).

#### **Event:** `error`

Emitted when an error occurs.

----
### Parameters

Parameters specify known versionbits deployments. Parameters should contain the following:
```js
{
  // number of blocks for the confirmation period
  // usually the same as the retarget period (in Bitcoin it is 2016)
  confirmationWindow: Number,

  // number of blocks in the period that must set the bit for a deployment
  // to make it "lock in"
  activationThreshold: Number,

  // an array of deployments to track
  deployments: [
    {
      bit: 0,
      name: 'csv',
      start: 1462060800,
      timeout: 1493596800
    }
  ]
}
```

For some examples, see these parameter repos:
- [`webcoin-bitcoin`](https://github.com/mappum/webcoin-bitcoin/blob/master/src/blockchain.js)
- [`webcoin-bitcoin-testnet`](https://github.com/mappum/webcoin-bitcoin-testnet/blob/master/src/blockchain.js)
