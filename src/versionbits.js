'use strict'

const { PassThrough } = require('stream')
const old = require('old')
const assign = require('object-assign')
const BlockchainState = require('blockchain-state')

const TIME_WINDOW = 11
const YEAR = 31536000

class VersionBits extends PassThrough {
  constructor (params, db) {
    super({ objectMode: true })
    if (!params) {
      throw new Error('Must specify versionbits params')
    }
    if (!db) {
      throw new Error('Must specify LevelUp instance')
    }
    assertValidParams(params)
    this.params = params

    this.deployments = params.deployments.map((deployment) => {
      return assign({
        count: 0,
        status: 'defined'
      }, deployment)
    })
    this.deploymentsIndex = {}
    for (let dep of this.deployments) {
      this.deploymentsIndex[dep.name] = dep
    }

    this.timestamps = []
    this.bip9Count = 0
    this.ready = false

    this.state = BlockchainState(
      this._addBlock.bind(this),
      this._removeBlock.bind(this),
      db)
    this.pipe(this.state)

    this._init()
  }

  get (id) {
    return assign({}, this.deploymentsIndex[id] || {})
  }

  getHash (cb) {
    return this.state.getHash(cb)
  }

  onceReady (f) {
    if (this.ready) return f()
    this.once('ready', f)
  }

  _init () {
    var db = this.state.getDB()
    db.createReadStream()
      .on('data', (entry) => {
        if (entry.key.startsWith('timestamp:')) {
          this.timestamps.push(JSON.parse(entry.value))
        } else if (entry.key.startsWith('dep:')) {
          let dep = JSON.parse(entry.value)
          let existing = this.deploymentsIndex[dep.name]
          if (existing) {
            this.deployments.splice(this.deployments.indexOf(existing), 1)
          }
          this.deploymentsIndex[dep.name] = dep
          this.deployments.push(dep)
        } else if (entry.key === 'bip9Count') {
          this.bip9Count = +entry.value
        }
      })
      .once('end', () => {
        console.log(this.deployments)
        this.ready = true
        this.emit('ready')
      })
  }

  _addBlock (block, tx, cb) {
    this.onceReady(() => {
      if (block.height % 1000 === 0) console.log(block.height)

      var { version, timestamp } = block.header
      this.timestamps.push(timestamp)
      if (this.timestamps.length > TIME_WINDOW) {
        this.timestamps.shift()
      }
      tx.put(`timestamp:${block.height}`, timestamp)
      tx.del(`timestamp:${block.height - TIME_WINDOW}`)

      if (this.timestamps.length < TIME_WINDOW) return cb()

      // if we are at a retarget, check state transitions
      if (block.height % this.params.confirmationWindow === 0) {
        var mtp = this._getMedianTimePast()

        for (let dep of this.deployments) {
          if (dep.status === 'lockedIn') {
            this._updateDeployment(dep.name, {
              status: 'activated',
              activationHeight: block.height,
              activationTime: mtp
            }, tx)
          } else if (dep.status === 'started' &&
          dep.count >= this.params.activationThreshold) {
            this._updateDeployment(dep.name, {
              status: 'lockedIn',
              lockInHeight: block.height,
              lockInTime: mtp
            }, tx)
          } else if (dep.status === 'started' && mtp >= dep.timeout) {
            this._updateDeployment(dep.name, {
              status: 'failed',
              lockInHeight: block.height,
              lockInTime: mtp
            }, tx)
          } else if (dep.status === 'defined' && mtp >= dep.start) {
            let existing = this._getStartedDeployment(dep.bit)
            if (existing) {
              // if there is already a deployment for this bit, set it to "failed"
              this._updateDeployment(existing.name, {
                status: 'failed'
              }, tx)
            }
            this._updateDeployment(dep.name, {
              status: 'started',
              startHeight: block.height,
              startTime: mtp
            }, tx)
          }
          this._updateDeployment(dep.name, { count: 0 }, tx)
          this.bip9Count = 0
        }
      }

      // increment deployments
      if (isBip9Version(version)) {
        this.bip9Count += 1
        tx.put('bip9Count', this.bip9Count)

        let bits = getBits(version)
        for (let bit of bits) {
          let dep = this._getStartedDeployment(bit)
          if (!dep) {
            // unknown deployment detected
            let name = `unknown-${bit}-${block.height}`
            this._updateDeployment(name, {
              count: 0,
              bit,
              status: 'started',
              name,
              unknown: true,
              start: timestamp,
              startHeight: block.height,
              timeout: timestamp + YEAR * 100 // we don't know the actual timeout
            }, tx)
            dep = this.deploymentsIndex[name]
          }

          this._updateDeployment(dep.name, { count: dep.count + 1 }, tx)
        }
      }

      cb()
    })
  }

  _removeBlock (block, tx, cb) {
    cb(new Error('reorgs not handled yet'))
  }

  _updateDeployment (id, values, tx) {
    var dep = this.deploymentsIndex[id] || null
    var oldStatus = dep ? dep.status : null
    if (!dep) {
      dep = values
      this.deployments.push(dep)
      this.deploymentsIndex[id] = dep
    } else {
      assign(dep, values)
    }
    var depCopy = assign({}, dep)
    tx.put(`dep:${id}`, dep, { valueEncoding: 'json' })
    this.emit('update', depCopy)
    if (oldStatus !== dep.status) {
      this.emit('status', depCopy)
      if (dep.unknown) this.emit('unknown', depCopy)
      this.emit(dep.status, depCopy)
    }
  }

  _getStartedDeployment (bit) {
    for (let dep of this.deployments) {
      if (dep.bit !== bit) continue
      if (dep.status !== 'started' && dep.status !== 'lockedIn') continue
      return dep
    }
  }

  _getMedianTimePast () {
    var timestamps = this.timestamps.slice(0).sort()
    return timestamps[Math.floor(TIME_WINDOW / 2)]
  }
}

module.exports = old(VersionBits)

function isBip9Version (version) {
  return (version & 0xe0000000) === 0x20000000
}

function getBits (version) {
  var bits = []
  for (let i = 0; i <= 27; i++) {
    if (version & (1 << i)) bits.push(i)
  }
  return bits
}

function assertValidParams (params) {
  if (!params.confirmationWindow ||
  !params.activationThreshold ||
  !params.deployments) {
    throw new Error('Invalid versionbits params')
  }
}
