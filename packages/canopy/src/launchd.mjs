// @ts-check
/** The launchd agent for `canopy`: KeepAlive restarts it whenever it exits, so `oakgreen restart` picks up new code. */
import { join } from 'node:path'
import { FOREST_PATH_ENV, serviceDir } from './forest.mjs'

export const LABEL = 'com.oakgreencc.canopy'

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * @param {{ node: string, bin: string, home: string, path: string, logFile: string, forest?: string }} o
 * No serve flags: canopy reads them from forest.json. `forest` is written only when it was set explicitly
 * (`$OAKGREEN_FOREST_CONFIG_PATH`); otherwise canopy finds the default again.
 */
export function plist({ node, bin, home, path, logFile, forest }) {
  const argv = [node, bin].map((a) => `    <string>${xml(a)}</string>`).join('\n')
  const env = { PATH: path, HOME: home, ...(forest ? { [FOREST_PATH_ENV]: forest } : {}) }
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>
</dict>
</plist>
`
}

/** @param {string} home */
export const plistPath = (home) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)

/** @param {string} home */
export const logPath = (home) => join(serviceDir('canopy', { home }), 'logs', 'canopy.log')
