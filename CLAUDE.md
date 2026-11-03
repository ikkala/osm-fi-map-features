# osm-fi-map-features

Map features from OpenStreetMap and Finnish open data, a tile at a time. README.md says what it makes and how to use
it, and the modules' header comments how they work: read the ones you need before a change.

## Checks

```sh
npm test            # the unit tests
npm run typecheck
npm run build       # dist/, which the package's exports point to
```

## Docs

- The README says what the package makes, from which sources, how to use it (options, exports, the tiles' format),
  the licences, and which module does what. How a module works (its rules, thresholds, constants and the places
  that show them) is in its comments, and the history and measurements behind a change are in its commit message.
- A change touches the README only when it adds or removes a module, an option, an export or a source, and then by a
  line or two pointing to the module. `src/readme.test.ts` holds the README to a budget of words: raise it only on
  purpose, not to make room for a change's rules.
- Comments: few and short, what the code does and briefly why.
