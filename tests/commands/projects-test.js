import {execSync} from 'child_process'
import fs from 'fs'
import path from 'path'

import copyTemplateDir from 'copy-template-dir'
import {spawn} from 'cross-spawn'
import EventSource from 'eventsource'
import expect from 'expect'
import rimraf from 'rimraf'
import temp from 'temp'
import kill from 'tree-kill'

import cli from '../../src/cli'

const States = {
  INIT: 'INIT',
  INIT_OK: 'INIT_OK',
  CHANGED_FILE: 'CHANGED_FILE',
  REBUILDING: 'REBUILDING'
}

describe('sample projects', function() {
  this.timeout(60000)

  describe('async-await project', () => {
    let originalCwd
    let originalNodeEnv
    let tmpDir

    before(done => {
      originalCwd = process.cwd()
      originalNodeEnv = process.env.NODE_ENV
      delete process.env.NODE_ENV
      tmpDir = temp.mkdirSync('async-await')
      copyTemplateDir(path.join(__dirname, '../fixtures/projects/async-await'), tmpDir, {}, err => {
        if (err) return done(err)
        process.chdir(tmpDir)
        execSync('npm install', {stdio: [0, 1, 2]})
        done()
      })
    })

    after(done => {
      process.chdir(originalCwd)
      process.env.NODE_ENV = originalNodeEnv
      rimraf(tmpDir, err => {
        done(err)
      })
    })

    it('builds successfully', done => {
      cli(['build'], err => {
        expect(err).toNotExist()
        done()
      })
    })

    it('tests successfully', done => {
      cli(['test'], err => {
        expect(err).toNotExist()
        done()
      })
    })
  })

  describe('Express middleware project', () => {
    let server
    let tmpDir
    let hmrClient

    let state = States.INIT
    let buildResults

    before(done => {
      process.env.NWB_EXPRESS_MIDDLEWARE = require.resolve('../../express')
      tmpDir = temp.mkdirSync('express-middleware')
      copyTemplateDir(path.join(__dirname, '../fixtures/projects/express-middleware'), tmpDir, {}, err => {
        if (err) return done(err)

        execSync('npm install', {cwd: tmpDir, stdio: [0, 1, 2]})

        server = spawn('node', ['server.js'], {cwd: tmpDir})

        // Start the HMR EventSource client when the initial build completes
        server.stdout.on('data', data => {
          console.log(`server stdout: ${data}`)
          if (state === States.INIT && /webpack built \w+ in \d+ms/.test(data)) {
            state = States.INIT_OK
            startHMRClient()
          }
        })

        // Fail if there's any error logging
        server.stderr.on('data', data => {
          console.log(`server stderr: ${data}`)
          done(new Error(`stderr output received: ${data}`))
        })

        function startHMRClient() {
          hmrClient = new EventSource('http://localhost:3001/__webpack_hmr')

          // Change a file to trigger a reload after the HMR client connects
          hmrClient.onopen = () => {
            console.log('HMR open: changing file in 1s')
            setTimeout(() => {
              state = States.CHANGED_FILE
              let content = fs.readFileSync(path.join(tmpDir, 'src/App.js'), 'utf-8')
              fs.writeFileSync(path.join(tmpDir, 'src/App.js'), content.replace('Welcome to', 'Change'))
            }, 1000)
          }

          // Fail on EventSource errors
          hmrClient.onerror = err => {
            done(new Error(`HMR client error: ${err}`))
          }

          hmrClient.onmessage = e => {
            if (e.data === '\uD83D\uDC93') {
              return
            }

            let data = JSON.parse(e.data)
            console.log(`HMR message: ${data.action}; state=${state}`)
            if (data.action === 'building') {
              if (state === States.CHANGED_FILE) {
                state = States.REBUILDING
              }
            }
            else if (data.action === 'built') {
              if (state === States.REBUILDING) {
                buildResults = data
                done()
              }
            }
            else {
              done(new Error(`HMR client received unexpected message: ${e.data}`))
            }
          }
        }
      })
    })

    after(done => {
      if (hmrClient) {
        hmrClient.close()
      }
      if (server) {
        kill(server.pid, 'SIGKILL', err => {
          if (err) return done(err)
          rimraf(tmpDir, done)
        })
      }
      else {
        rimraf(tmpDir, done)
      }
    })

    it('handles hot reloading with webpack', () => {
      expect(buildResults.warnings).toEqual([])
      expect(buildResults.errors).toEqual([])
    })
  })
})
