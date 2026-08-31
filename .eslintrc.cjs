// ESLint has never actually run in this repository. `npm run lint` is wired up in package.json and
// @electron-toolkit/eslint-config-ts is installed, but no config file existed, so every invocation
// died with "ESLint couldn't find a configuration file" naming whichever file it happened to walk
// into first (backend/src/routes, which made it read like a problem with that folder). The quality
// gate has been reporting a hard crash rather than a result for as long as it has been listed.
//
// Legacy .eslintrc format on purpose: this is ESLint 8.57, where flat config is opt-in and the
// shareable config above is written for eslintrc. Moving to eslint.config.js means upgrading both.
module.exports = {
  root: true,
  extends: ['@electron-toolkit/eslint-config-ts/recommended'],
  plugins: ['react-hooks'],
  ignorePatterns: [
    'node_modules/',
    'out/',
    'dist/',
    // A separate sub-project with its own package.json and tsconfig. Linting it from the root
    // would apply this project's settings to code that never asked for them; it needs its own
    // config if it is ever to be linted.
    'backend/',
    // Bundled esbuild output from the research scripts -- generated, not authored.
    'research/.*.mjs',
    '*.mjs',
    '*.cjs'
  ],
  env: {
    browser: true,
    node: true,
    es2022: true
  },
  rules: {
    // Three files already carry `eslint-disable-next-line react-hooks/exhaustive-deps` comments,
    // written by someone who assumed this plugin was configured. It was not, so ESLint reported
    // "Definition for rule was not found" at each of them -- a suppression pointing at nothing.
    // Enabling the plugin makes those comments mean what they say, and turns the rule on for the
    // polling hooks this app is full of.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    // Underscore-prefixed bindings are the established way in this codebase to say "required by
    // the signature, deliberately unused" -- see schedulingSignature.ts, where the parameter
    // documents a field the signature must skip.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
    ]
  },
  overrides: [
    {
      // Tests and research scripts are not the shipped app, and neither has ever declared return
      // types -- 139 of the 194 findings were here. Enforcing a convention retroactively on code
      // that never adopted it would be inventing a rule rather than checking one, and would bury
      // the findings that matter in production code under four times as many that do not.
      files: ['tests/**/*.ts', 'tests/**/*.tsx', 'research/**/*.ts'],
      rules: {
        '@typescript-eslint/explicit-function-return-type': 'off'
      }
    }
  ]
}
