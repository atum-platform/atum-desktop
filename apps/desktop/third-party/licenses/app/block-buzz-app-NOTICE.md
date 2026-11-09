# Block Buzz source attribution

The Team Space sidebar interaction layer is adapted from Block Buzz App at
revision `c2210b45bb6f539f1d236d18b284c16566e70602`:

https://github.com/block/buzz-app/tree/c2210b45bb6f539f1d236d18b284c16566e70602

The relevant upstream NOTICE states:

> The relay read model in `src/features/relay` and development read broker in
> `browser-host` are adapted from the supplied Astra example. The channel layout
> and virtualizer behavior are adapted from that example's Channels view.
>
> Astra's presentation is derived from Block Buzz `prototypes/project-cube-orbit`,
> revision `0cd836965110adb18b95747c8656779c470d6e4d`:
> https://github.com/block/buzz/tree/0cd836965110adb18b95747c8656779c470d6e4d/prototypes/project-cube-orbit
>
> The Apache-2.0 license is preserved in `LICENSE`.

Atum changes replace Buzz relay, Tauri, plugin and Cordis state with Atum's
Matrix/company authority, use Atum controls and design tokens, scope persisted
sidebar width and selected page to the signed-in Atum account, and retain only
the sidebar frame, list, row, section, label-overflow, resize, declared-page
placement and roving tab-focus interactions.
