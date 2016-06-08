'use strict'

const EventEmitter = require('events')
const old = require('old')
const to = require('to2').obj
const assign = require('object-assign')

const TIME_WINDOW = 11

class VersionBits extends EventEmitter {
  constructor (params) {
    super()
    if (!params) {
      throw new Error('Must specify versionbits params')
    }
    this.params = params
    this.last = null
    this.window = []
    this.bip9Count = 0
    this.deployments = params.deployments.map((deployment) => {
      return assign({
        count: 0,
        status: 'defined'
      }, deployment)
    })
    // TODO: fetch statuses from db
  }

  createWriteStream () {
    return to((block, enc, cb) => {
      if (this.last) {
        try {
          this._checkBlockOrder(block)
        } catch (err) {
          return cb(err)
        }
      }
      this.last = block

      if (block.height % 20000 === 0) {
        console.log('height:', block.height, 'version:', '0x'+block.header.version.toString(16))
      }
      if (block.add) {
        this._addBlock(block)
      } else {
        this._removeBlock()
      }

      cb()
    })
  }

  getDeployment (name) {
    for (let dep of this.deployments) {
      if (dep.name === name) return assign({}, dep)
    }
  }

  _checkBlockOrder (block) {
    var actualHeight = block.height
    var expectedHeight = this.last.height + (block.add ? 1 : 0)
    if (actualHeight !== expectedHeight) {
      throw new Error('Got block with incorrect height. Expected ' +
        `${expectedHeight}, but got ${actualHeight}`)
    }

    var actualHash = block.add ? block.header.prevHash : block.header.getHash()
    var expectedHash = this.last.header.getHash()
    if (!actualHash.equals(expectedHash)) {
      throw new Error('Got block with incorrecty hash. Expected ' +
        `"${expectedHash.toString('hex')}" but got ` +
        `"${actualHash.toString('hex')}"`)
    }
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
          dep.status = 'activated'
          dep.activationHeight = block.height
          dep.activationTime = timestamp
          this.emit('activation', assign({}, dep))
          this.emit('change', assign({}, dep))
          // TODO: store status in db
        }
      }
    }

    var mtp = this._getMedianTimePast()
    for (let dep of this.deployments) {
      if (dep.status === 'defined' || dep.status === 'started') {
        if (mtp >= dep.timeout) {
          dep.status = 'failed'
          this.emit('fail', assign({}, dep))
          this.emit('change', assign({}, dep))
        } else if (dep.status === 'defined' && mtp >= dep.start) {
          dep.status = 'started'
          dep.startHeight = block.height
          this.emit('start', assign({}, dep))
          this.emit('change', assign({}, dep))
        }
      }
    }

    if (this.window.length > this.params.confirmationWindow) {
      let expiredEntry = this.window.shift()
      if (isBip9Version(expiredEntry.version)) {
        this.bip9Count -= 1
        for (let dep of expiredEntry.deployments) {
          if (dep.status !== 'started') continue
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
          return this.emit('error', new Error('Saw versionbit for an ' +
            `unknown deployment (height=${block.height}, ` +
            `version=0x${version.toString(16)}, bit=${bit})`))
        }
        dep.count++
        if (dep.count === this.params.activationThreshold) {
          dep.status = 'lockedIn'
          dep.lockInHeight = block.height
          dep.lockInTime = timestamp
          this.emit('lockIn', assign({}, dep))
          this.emit('change', assign({}, dep))
          // TODO: store status change in db
        }
      }
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
