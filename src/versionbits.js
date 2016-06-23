'use strict'

const EventEmitter = require('events')
const old = require('old')
const assign = require('object-assign')

const TIME_WINDOW = 11
const REORG_WINDOW = 100
const YEAR = 31536000

class VersionBits extends EventEmitter {
  constructor (params) {
    super()
    if (!params) {
      throw new Error('Must specify versionbits params')
    }
    this.params = params
    this.window = []
    this.bip9Count = 0
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
    this.log = this.deployments.slice(0)
    // TODO: fetch statuses from db
  }

  get (id) {
    return assign({}, this.deploymentsIndex[id] || {})
  }

  _addBlock (block) {
    var { version, timestamp } = block.header
    var windowEntry = { version, timestamp, deployments: [] }
    this.window.push(windowEntry)
    if (this.window.length < TIME_WINDOW) return

    if (block.height % this.params.confirmationWindow === 0) {
      for (let dep of this.deployments) {
        if (dep.status !== 'lockedIn') continue
        if (block.height - dep.lockInHeight >= this.params.confirmationWindow) {
          this._updateDeployment(dep.name, {
            status: 'activated',
            activationHeight: block.height,
            activationTime: timestamp
          }, windowEntry)
        }
      }
    }

    var mtp = this._getMedianTimePast()
    for (let dep of this.deployments) {
      if (dep.status === 'defined' || dep.status === 'started') {
        if (mtp >= dep.timeout) {
          this._updateDeployment(dep.name, { status: 'failed' }, windowEntry)
        } else if (dep.status === 'defined' && mtp >= dep.start) {
          this._updateDeployment(dep.name, {
            status: 'started',
            startHeight: block.height
          }, windowEntry)
        }
      }
    }

    if (this.window.length > this.params.confirmationWindow) {
      let expiredEntry = this.window.shift()
      if (isBip9Version(expiredEntry.version)) {
        this.bip9Count -= 1
        for (let dep of expiredEntry.deployments) {
          dep.count--
        }
      }
    }

    if (isBip9Version(version)) {
      this.bip9Count += 1
      let bits = getBits(version)
      for (let bit of bits) {
        let dep = this._getStartedDeployment(bit)
        if (!dep) {
          dep = {
            count: 0,
            bit,
            status: 'started',
            name: `unknown-${bit}-${block.height}`,
            unknown: true,
            start: timestamp,
            startHeight: block.height,
            timeout: timestamp + YEAR // just a guess, we don't know the actual timeout
          }
          this.deployments.push(dep)
          this.deploymentsIndex[dep.name] = dep
          // TODO: store deployment in db
          this.emit('unknown', assign({}, dep))
          this.emit('started', assign({}, dep))
          this.emit('update', assign({}, dep))
        }
        var diff = { count: dep.count + 1 }
        if (dep.count === this.params.activationThreshold) {
          diff = assign(diff, {
            status: 'lockedIn',
            lockInHeight: block.height,
            lockInTime: timestamp
          })
        }
        this._updateDeployment(dep.name, diff, windowEntry)
      }
    }
  }

  _updateDeployment (id, values, entry) {
    var dep = this.deploymentsIndex[id]
    var oldDep = assign({}, dep)
    if (!entry.deployments.includes(dep)) {
      entry.deployments.push(dep)
    }
    assign(dep, values)
    if (oldDep.status !== dep.status) {
      var dep2 = assign({}, dep)
      this.emit('update', dep2)
      if (dep.unknown) this.emit('unknown', dep2)
      this.emit(dep.status, dep2)
    }
  }

  _removeBlock () {
    this.emit('error', new Error('reorg handling not yet implemented'))
  }

  _getStartedDeployment (bit) {
    for (let dep of this.deployments) {
      if (dep.bit !== bit) continue
      if (dep.status !== 'started' && dep.status !== 'lockedIn') continue
      return dep
    }
  }

  _getMedianTimePast () {
    if (this.window.length < TIME_WINDOW) {
      throw new Error('Not enough blocks buffered to calculate median time past')
    }
    var entries = this.window.slice(this.window.length - TIME_WINDOW)
    var timestamps = entries.map((entry) => entry.timestamp).sort()
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
