var test = require('tape')
var level = require('levelup')
var memdown = require('memdown')
var VersionBits = require('../index.js')

function createDb () {
  return level(String(Math.random()), { db: memdown })
}

test('VersionBits constructor', function (t) {
  var params = {
    confirmationWindow: 20,
    activationThreshold: 15,
    deployments: []
  }
  t.test('normal constructor', function (t) {
    var vb = new VersionBits(params, createDb())
    t.ok(vb instanceof VersionBits, 'got VersionBits instance')
    t.end()
  })
  t.test('constructor without "new"', function (t) {
    var vb = VersionBits(params, createDb())
    t.ok(vb instanceof VersionBits, 'got VersionBits instance')
    t.end()
  })
  t.test('constructor without params', function (t) {
    try {
      var vb = VersionBits()
      t.notOk(vb, 'should have thrown')
    } catch (err) {
      t.ok(err, 'error thrown')
      t.equal(err.message, 'Must specify versionbits params')
      t.end()
    }
  })
  t.test('constructor without db', function (t) {
    try {
      var vb = VersionBits(params)
      t.notOk(vb, 'should have thrown')
    } catch (err) {
      t.ok(err, 'error thrown')
      t.equal(err.message, 'Must specify LevelUp instance')
      t.end()
    }
  })
  t.test('constructor with invalid params', function (t) {
    var invalidParams = [
      {},
      { confirmationWindow: 123 },
      { confirmationWindow: 123, activationThreshold: 456 },
      { activationThreshold: 123 },
      { deployments: [] }
    ]
    for (var i = 0; i < invalidParams.length; i++) {
      try {
        var vb = VersionBits(invalidParams[i], createDb())
        t.notOk(vb, 'should have thrown')
      } catch (err) {
        t.ok(err, 'error thrown')
        t.equal(err.message, 'Invalid versionbits params')
      }
    }
    t.end()
  })
})

test('get deployments', function (t) {
  var params = {
    confirmationWindow: 20,
    activationThreshold: 15,
    deployments: [
      {
        id: 'foo',
        bit: 0,
        start: 5,
        timeout: 105
      }, {
        id: 'bar',
        bit: 1,
        start: 50,
        timeout: 150
      }
    ]
  }
  var vb = new VersionBits(params, createDb())
  t.test('get deployment after initial constructor', function (t) {
    var dep = vb.get('foo')
    t.ok(dep, 'got deployment')
    t.equal(dep.id, 'foo', 'correct id')
    t.equal(dep.bit, 0, 'correct bit')
    t.equal(dep.start, 5, 'correct start')
    t.equal(dep.timeout, 105, 'correct timeout')
    t.equal(dep.count, 0, 'correct count')
    t.equal(dep.status, 'defined', 'correct status')
    t.end()
  })
})
