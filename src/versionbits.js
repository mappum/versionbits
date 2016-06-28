'use strict'

const { PassThrough } = require('stream')
const old = require('old')
const assign = require('object-assign')
const BlockchainState = require('blockchain-state')

const TIME_WINDOW = 10
const REORG_WINDOW = 100

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

    this.window = []
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
        if (entry.key.startsWith('entry:')) {
          this.window.push(JSON.parse(entry.value))
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
      var windowEntry = {
        version,
        timestamp,
        prevState: {}
      }
      this.window.push(windowEntry)

      var done = () => {
        tx.put(`entry:${block.height}`, windowEntry, { valueEncoding: 'json' })
        for (let id in windowEntry.prevState) {
          tx.put(`dep:${id}`, this.deploymentsIndex[id], { valueEncoding: 'json' })
        }
        cb()
      }

      if (this.window.length < TIME_WINDOW) return done()

      // if we are at a retarget, activate eligible locked-in deployments
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

      // based on time, handle deployment starts and timeouts
      var mtp = this._getMedianTimePast()
      for (let dep of this.deployments) {
        if (dep.status === 'defined' || dep.status === 'started') {
          if (mtp >= dep.timeout) {
            this._updateDeployment(dep.name, { status: 'failed' }, windowEntry)
          } else if (dep.status === 'defined' && mtp >= dep.start) {
            let existing = this._getStartedDeployment(dep.bit)
            if (existing) {
              // if there is already a bip at this bit, set it to "failed"
              this._updateDeployment(existing.name, {
                status: 'failed'
              }, windowEntry)
            }
            this._updateDeployment(dep.name, {
              status: 'started',
              startHeight: block.height
            }, windowEntry)
          }
        }
      }

      // remove old entry from the current counts
      if (this.window.length > this.params.confirmationWindow) {
        let expiredEntry = this.window[this.window.length - this.params.confirmationWindow - 1]
        if (isBip9Version(expiredEntry.version)) {
          this.bip9Count -= 1
          tx.put('bip9Count', this.bip9Count)
          for (let id in expiredEntry.prevState) {
            let { status, count } = this.deploymentsIndex[id]
            if (status === 'active') continue
            count -= 1
            this._updateDeployment(id, { count }, windowEntry)
          }
        }
      }

      // shift entries off of window
      if (this.window.length > this.params.confirmationWindow + REORG_WINDOW) {
        this.window.shift()
        let height = block.height - (this.params.confirmationWindow + REORG_WINDOW)
        tx.del(`entry:${height}`)
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
            }, windowEntry)
            dep = this.deploymentsIndex[name]
          }

          var diff = { count: dep.count + 1 }
          if (dep.status === 'started' &&
          dep.count === this.params.activationThreshold) {
            assign(diff, {
              status: 'lockedIn',
              lockInHeight: block.height,
              lockInTime: timestamp
            })
          }
          this._updateDeployment(dep.name, diff, windowEntry)
        }
      }

      done()
    })
  }

  _removeBlock (block, tx, cb) {
    if (this.window.length - this.params.activationThreshold <= 0) {
      cb(new Error('Reached maximum reorg window, can\'t rewind any further'))
      return
    }
    var windowEntry = this.window.pop()
    for (let id in windowEntry.prevState) {
      if (windowEntry.prevState[id] === null) {
        delete this.deployments[id]
      } else {
        assign(this.deployments[id], windowEntry.prevState[id])
        tx.put(`dep:${id}`, this.deployments[id], { valueEncoding: 'json' })
      }
    }
    cb()
  }

  _updateDeployment (id, values, entry) {
    var dep = this.deploymentsIndex[id] || null
    var oldDep = assign({}, dep)
    if (!entry.prevState[id]) {
      entry.prevState[id] = dep ? oldDep : null
    }
    if (!dep) {
      dep = values
      this.deployments.push(dep)
      this.deploymentsIndex[dep.name] = dep
    } else {
      assign(dep, values)
    }
    var depCopy = assign({}, dep)
    this.emit('update', depCopy)
    if (oldDep.status !== dep.status) {
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
    if (this.window.length < TIME_WINDOW) {
      throw new Error('Not enough blocks buffered to calculate median time past')
    }
    var entries = this.window.slice(this.window.length - TIME_WINDOW - 1, this.window.length - 1)
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

function assertValidParams (params) {
  if (!params.confirmationWindow ||
  !params.activationThreshold ||
  !params.deployments) {
    throw new Error('Invalid versionbits params')
  }
}
