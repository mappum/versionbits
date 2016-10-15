'use strict'

const { PassThrough } = require('stream')
const old = require('old')
const assign = require('object-assign')
const BlockchainState = require('blockchain-state')
const DState = require('dstate')
const clone = require('clone')

const TIME_WINDOW = 11
const WINDOW = 100
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

    this.state = {
      deployments: params.deployments.map((deployment) => {
        return assign({
          count: 0,
          status: 'defined'
        }, deployment)
      }),
      timestamps: [],
      bip9Count: 0
    }
    this.deploymentsIndex = {}
    for (let dep of this.deployments) {
      this.deploymentsIndex[dep.id] = dep
    }

    this.ready = false

    this.chainState = BlockchainState(
      this._addBlock.bind(this),
      this._removeBlock.bind(this),
      db)
    this.chainState.on('block', (block) => this.emit('block', block))
    this.chainState.on('add', (block) => this.emit('add', block))
    this.chainState.on('remove', (block) => this.emit('remove', block))

    this.stateDb = DState(this.chainState.getDB())
    this.pipe(this.chainState)

    this._init()
  }

  get deployments () { return this.state.deployments }
  get timestamps () { return this.state.timestamps }
  get bip9Count () { return this.state.bip9Count }

  get (id) {
    return clone(this.deploymentsIndex[id])
  }

  getDeployments () {
    return clone(this.state.deployments)
  }

  getHash (cb) {
    return this.chainState.getHash(cb)
  }

  onceReady (f) {
    if (this.ready) return f()
    this.once('ready', f)
  }

  _init () {
    var done = (err) => {
      if (err) return this.emit('error', err)
      this.ready = true
      this.emit('ready')
    }
    this.stateDb.getState((err, state) => {
      if (err) return done(err)
      if (!state) {
        return this.stateDb.commit(this.state, done)
      }
      this.state = state
      this._indexDeployments()
      done()
    })
  }

  _indexDeployments () {
    for (let dep of this.deployments) {
      this.deploymentsIndex[dep.id] = dep
    }
  }

  _addBlock (block, tx, cb) {
    var done = () => {
      this.stateDb.commit(this.state, { tx }, (err, index) => {
        if (err) return cb(err)
        if (index < WINDOW) return cb()
        this.stateDb.prune(index - WINDOW, { tx }, cb)
      })
    }
    this.onceReady(() => {
      var { version, timestamp } = block.header
      var timestamps = this.timestamps
      timestamps.push(timestamp)
      if (timestamps.length > TIME_WINDOW) timestamps.shift()
      if (timestamps.length < TIME_WINDOW) return done()

      // if we are at a retarget, check status transitions
      if (block.height % this.params.confirmationWindow === 0) {
        var mtp = this._getMedianTimePast()

        for (let dep of this.deployments) {
          if (dep.status === 'lockedIn') {
            this._updateDeployment(dep.id, {
              status: 'activated',
              activationHeight: block.height,
              activationTime: mtp
            })
          } else if (dep.status === 'started' &&
          dep.count >= this.params.activationThreshold) {
            this._updateDeployment(dep.id, {
              status: 'lockedIn',
              lockInHeight: block.height,
              lockInTime: mtp
            })
          } else if (dep.status === 'started' && mtp >= dep.timeout) {
            this._updateDeployment(dep.id, {
              status: 'failed',
              lockInHeight: block.height,
              lockInTime: mtp
            })
          } else if (dep.status === 'defined' && mtp >= dep.start) {
            let existing = this._getStartedDeployment(dep.bit)
            if (existing) {
              // if there is already a deployment for this bit, set it to "failed"
              this._updateDeployment(existing.id, { status: 'failed' })
            }
            this._updateDeployment(dep.id, {
              status: 'started',
              startHeight: block.height,
              startTime: mtp
            })
          }
          this._updateDeployment(dep.id, { count: 0 })
          this.state.bip9Count = 0
        }
      }

      // increment deployments
      if (isBip9Version(version)) {
        this.state.bip9Count += 1

        let bits = getBits(version)
        for (let bit of bits) {
          let dep = this._getStartedDeployment(bit)
          if (!dep) {
            // unknown deployment detected
            let id = `unknown-${bit}-${block.height}`
            this._updateDeployment(id, {
              count: 0,
              bit,
              status: 'started',
              name: 'Unknown',
              id,
              unknown: true,
              start: timestamp,
              startHeight: block.height,
              timeout: timestamp + YEAR * 100 // we don't know the actual timeout
            })
            dep = this.deploymentsIndex[id]
          }
          this._updateDeployment(dep.id, { count: dep.count + 1 })
        }
      }
      done()
    })
  }

  _removeBlock (block, tx, cb) {
    this.stateDb.getIndex((err, index) => {
      if (err) return cb(err)
      this.stateDb.rollback(index - 1, (err, state) => {
        if (err) return cb(err)
        this.state = state
        this._indexDeployments()
        cb()
      })
    })
  }

  _updateDeployment (id, values) {
    var dep = this.deploymentsIndex[id] || null
    var oldStatus = dep ? dep.status : null
    if (!dep) {
      dep = values
      this.deployments.push(dep)
      this.deploymentsIndex[id] = dep
    } else {
      assign(dep, values)
    }
    var depCopy = clone(dep)
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
    var index = this.timestamps.length - TIME_WINDOW
    var timestamps = this.timestamps.slice(index).sort()
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
