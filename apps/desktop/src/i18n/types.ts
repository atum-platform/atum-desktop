// Desktop i18n type contract.
//
// `Translations` is the single source of truth for every translatable string
// surface. Fully translated locale files may satisfy this interface directly;
// partial locales should use `defineLocale` so missing desktop-only strings
// fall back to English while new keys remain type-checked.

import type { DesktopLocale } from '../../shared/desktop-locale'

export type Locale = DesktopLocale

export type ToolTitleKey =
  | 'browser_back'
  | 'browser_cdp'
  | 'browser_click'
  | 'browser_console'
  | 'browser_dialog'
  | 'browser_get_images'
  | 'browser_navigate'
  | 'browser_press'
  | 'browser_scroll'
  | 'browser_snapshot'
  | 'browser_type'
  | 'browser_vision'
  | 'clarify'
  | 'cronjob'
  | 'edit_file'
  | 'execute_code'
  | 'image_generate'
  | 'list_files'
  | 'patch'
  | 'read_file'
  | 'search_files'
  | 'session_search_recall'
  | 'terminal'
  | 'todo'
  | 'vision_analyze'
  | 'web_extract'
  | 'web_search'
  | 'write_file'

interface ToolTitleCopy {
  done: string
  pending: string
  pendingAction: string
}

interface ModeOptionCopy {
  label: string
  description: string
}

interface AuxTaskCopy {
  label: string
  hint: string
}

export interface Translations {
  cloud: {
    deviceStatusUnconfirmed: string
    wordRefusal: string
    stopRefused: string
    driveFull: string
    title: string
    /** Settings' one switch: whether assistants may use this Mac (enrolls it; 0.19.4 Q4). */
    allowMac: string
    /** "Let assistants use this Mac" did not enroll it: what to do (src/matrix/cloud-failure.ts). */
    enrollFailure: {
      signed_out: string
      not_ready: string
      key_unreadable: string
      cancelled: string
      no_prompt: string
      unavailable: string
      offline: string
      refused: string
      keys: string
      generic: string
    }
  }
  /** Transcript timeline notes (system rows between turns). */
  timeline: {
    modelChanged: (from: string, to: string) => string
    modelChangedTo: (to: string) => string
    delegationFinished: string
    delegationCountFinished: (count: number) => string
  }
  common: {
    apply: string
    back: string
    save: string
    saving: string
    cancel: string
    change: string
    choose: string
    clear: string
    close: string
    collapse: string
    confirm: string
    connect: string
    connecting: string
    continue: string
    copied: string
    copy: string
    copyFailed: string
    delete: string
    docs: string
    done: string
    error: string
    expand: string
    failed: string
    formatJson: string
    free: string
    loading: string
    notSet: string
    refresh: string
    remove: string
    replace: string
    retry: string
    run: string
    send: string
    set: string
    skip: string
    update: string
    tryHint: (term: string) => string
    on: string
    off: string
  }

  intro: {
    heading: string
    body: string
  }

  dm: {
    sectionTitle: string
    brandLine: string
    compose: string
    send: string
    retry: string
    sending: string
    sendFailed: string
    noMessages: string
    startConversation: (name: string) => string
    noConversations: string
    offline: string
    reconnecting: string
    authExpired: string
    authExpiredAction: string
    errorGeneric: string
    loadingMessages: string
    today: string
    yesterday: string
    unreadCount: (count: number) => string
    signedInAs: (name: string) => string
    notSignedIn: string
    signIn: string
    identifier: string
    identifierHint: string
    identifierPlaceholder: string
    identifierRequired: string
    password: string
    passwordRequired: string
    signingIn: string
    googlePending: string
    signInFailed: string
    signInOffline: string
    signInStorage: string
    signInPlatform: string
    signInLocal: string
    signInProviderDown: string
    signInNotice: string
    retrySignInCheck: string
    checkingSignIn: string
    signInRetryFailed: string
    signInBrowserIncomplete: string
    signInDeclined: string
    signInRetry: string
    continueWithGoogle: string
    or: string
    signOut: string
    cancelSignIn: string
    you: string
    messageDelivered: string
    messageRead: string
    unavailable: string
    reply: string
    replyingTo: string
    cancelReply: string
    edited: string
    edit: string
    recall: string
    recalled: string
    reactions: string
    attachImage: string
    /** The composer's single "+" menu: app actions, then attachments. */
    composerMenu: string
    uploading: (progress: number) => string
    uploadFailed: string
    typing: string
    searchMessages: string
    searchPlaceholder: string
    noSearchResults: string
    download: string
    /** The hosted @Atum mention affordance in human DMs. */
    mention: {
      hostedHint: string
      presenceTitle: string
      presenceDisclosure: string
      contextTitle: string
      contextDisclosure: string
      replying: string
      completed: string
      insufficientProtons: string
      targetCompleted: (name: string) => string
      targetReplying: (name: string) => string
      targetInsufficientProtons: (name: string) => string
      targetFailed: (name: string, code: string | null) => string
      targetsUnavailable: string
      failed: (code: string | null) => string
    }
    group: {
      advisory: {
        creationDisabled: string
        title: string
        ordinary: string
        disclosure: string
        minimum: string
        empty: string
        unavailable: string
        advisors: string
        roundDisclosure: string
        needsInput: string
        openActivity: string
        stop: string
        continue: string
        running: string
        completed: string
        stopped: string
        failed: string
        add: string
        historyDisclosure: string
        ownerBoundary: string
      }
      controlsLabel: string
      members: string
      owner: string
      roomName: string
      rename: string
      addMember: string
      addSpecialist: string
      addAssistant: string
      openSpecialist: string
      remove: string
      removeMember: (name: string) => string
      transfer: string
      transferOwner: string
      retire: string
      leave: string
      reportAction: string
      unavailable: string
      membershipEnded: string
      retiredReadOnly: string
      ownerTransferBeforeLeave: string
      operationQueued: string
      operationSending: string
      operationSent: string
      operationFailed: string
      operationConflicted: string
      quoteAction: string
      clearQuote: string
      quotePreview: string
      replyingToSpecialist: (name: string) => string
      replySpecialistDisclosure: string
      specialistTargetState: (state: 'available' | 'specialist_not_linked' | 'specialist_room_unsupported') => string
      assistantTargetState: (state: string) => string
      sharedContextTitle: string
      sharedContextDisclosure: string
      replyingToAssistant: (name: string) => string
      participant: {
        myApp: (name: string) => string
        appOwnedBy: (owner: string, name: string) => string
        agentOwnedBy: (owner: string, name: string) => string
      }
      persona: {
        title: string
        description: string
        loading: string
        unavailable: string
        disclosure: string
        ready: string
        enabled: string
        bound: string
        approved: string
        reconnect: string
        rolloutDisabled: string
        offline: string
        approve: string
        revoke: string
        saving: string
        review: string
      }
      create: {
        title: string
        description: string
        unavailable: string
        creationDisabled: string
        nameLabel: string
        namePlaceholder: string
        nameInvalid: string
        members: string
        specialists: string
        agents: string
        loading: string
        peopleEmpty: string
        appsEmpty: string
        agentsEmpty: string
        appUnavailable: string
        agentsUnavailable: string
        agentUnavailable: (availability: string) => string
        specialistLimit: (limit: number) => string
        specialistUnsupported: string
        memberLimit: (limit: number) => string
        historyDisclosure: string
        privateDisclosure: string
        sharedDisclosure: string
        submit: string
        sending: string
        queued: string
        sent: string
        failed: string
      }
      events: {
        member: string
        formerMember: string
        created: (actor: string) => string
        memberAdded: (actor: string, subject: string) => string
        memberRemoved: (actor: string, subject: string) => string
        memberLeft: (subject: string) => string
        ownerTransferred: (actor: string, subject: string) => string
        renamed: (actor: string) => string
        retired: (actor: string) => string
        accountDeleted: (subject: string) => string
      }
      report: {
        title: string
        description: (target: string) => string
        reason: string
        reasons: Record<'harassment' | 'spam' | 'unsafe' | 'other', string>
        note: string
        submit: string
        sending: string
        queued: string
        sent: string
        failed: string
      }
    }
    /** Resource/attachment cards rendered inside a hosted DM bubble. */
    resource: {
      open: string
      openExternal: string
      openFailed: string
      openAria: (name: string) => string
      kind: {
        document: string
        file: string
        image: string
        page: string
      }
    }
    artifact: {
      closeAria: (name: string) => string
      open: string
      openAria: (name: string) => string
      generating: string
      reopenClosed: string
      reopenEmpty: string
      reopenLimit: string
      retry: string
      tabsAria: string
      state: Record<
        'loading' | 'waiting' | 'missing' | 'denied' | 'offline' | 'unsupported' | 'error',
        { title: string; body: string }
      >
    }
    /** Andy's memory receipt. Outcome labels only — never memory content. */
    memory: {
      outcome: {
        granted_empty: string
        not_authorized: string
        revoked: string
        supplied: string
      }
      version: (value: number) => string
    }
    /** Specialist dispatch state while a hosted turn is in flight. */
    specialist: {
      pending: string
      pendingWith: (name: string) => string
    }

    /**
     * Per-app intake: an app declaring what it still needs before it can work.
     * There is deliberately NO per-field copy here — the form is built from the
     * app's own declaration, so a label comes from the server when it sends one
     * and otherwise from the field name itself. Hardcoding one app's fields into
     * the shell is exactly the coupling this surface exists to avoid.
     */
    intake: {
      eyebrow: string
      title: (app: string) => string
      description: string
      loading: string
      loadFailed: string
      retry: string
      open: string
      required: string
      choose: string
      submit: string
      submitting: string
      submitFailed: string
      close: string
    }

    /** Linking an Atum account to an account the user already has on the app. */
    connect: {
      finishing: (app: string) => string
      unavailable: (app: string) => string
      eyebrow: string
      title: (app: string) => string
      description: (app: string) => string
      manualDescription: (app: string) => string
      statusDescription: (app: string) => string
      reconnectTitle: (app: string) => string
      linkedTitle: (app: string) => string
      reconnectDescription: (app: string) => string
      connect: string
      reconnect: string
      notNow: string
      starting: string
      browserHint: string
      checkAgain: string
      checking: string
      checkFailed: string
      statusUnavailable: string
      retryStatus: string
      dismissFailed: string
      failed: string
      linked: (app: string) => string
      done: string
      timeout: (app: string) => string
    }
  }

  /** The Atum product shell (rail / roster / chat rim / workspace / auth gate).
   *  Separate from `dm` on purpose: `dm` is the hosted-messaging vocabulary,
   *  `atum` is the shell's own. Shared strings are reused from `dm`, not
   *  duplicated here. */
  atum: {
    /** The desktop pet overlay: its composer and speech bubble. */
    pet: {
      composerPlaceholder: string
      /** Shown when the turn is blocked on the user. */
      yourTurn: string
      /** Shown when the turn failed. */
      somethingBroke: string
      /** Right-click / footer actions. The same verbs on every surface. */
      show: string
      hide: string
      popOut: string
      putBack: string
      settings: string
      /** The store, from every pet menu. */
      store: string
    }
    /** Private owner-only awareness view. Source content remains untrusted. */
    awareness: {
      title: string
      subtitle: string
      privateOnly: string
      sources: string
      evidence: string
      /** Accessible name for the loader, rather than a visible loading sentence. */
      loading: string
      unavailable: string
      unavailableDescription: string
      stale: string
      degraded: string
      noSources: string
      noSourcesDescription: string
      noEvidence: string
      noEvidenceDescription: string
      openCitation: string
      openingCitation: string
      citationUnavailable: string
      citationFailed: string
      untrusted: string
      preview: string
      previewDescription: string
      asOf: (date: string) => string
      processedThrough: (date: string) => string
      occurredAt: (date: string) => string
      fileVersion: (version: string) => string
      memoryRevision: (revision: string) => string
      previewCitation: (source: string) => string
      settings: {
        title: string
        description: string
        privacy: string
        loading: string
        failed: string
        empty: string
        emptyDescription: string
        include: string
        exclude: string
        forget: string
        confirmForget: string
        includedDescription: string
        excludedDescription: string
        forgottenDescription: string
        pending: string
      }
      roomInfo: {
        title: string
        plain: string
        encrypted: string
      }
      sourceKinds: {
        assistant_chat: string
        human_dm: string
        human_group: string
        app_exchange: string
        drive_file: string
        native_memory: string
        owner_statement: string
      }
      states: {
        ready: string
        catching_up: string
        partial: string
        offline: string
        excluded: string
        needs_keys: string
        paused: string
        error: string
      }
      reasons: {
        google_fence: string
        cloud_access_ended: string
        owner_paused: string
        keys_missing: string
        backfill_pending: string
        unsupported_media: string
        service_unavailable: string
        device_offline: string
        excluded_by_owner: string
        temporary_conversation: string
      }
      epistemic: {
        statement: string
        question: string
        quotation: string
        proposal: string
        decision: string
        commitment: string
        correction: string
        unknown: string
      }
      citationKinds: {
        matrix_event: string
        drive_file: string
        memory: string
      }
    }
    /** The Pet Store page. */
    pets: {
      title: string
      subtitle: string
      petHoldPurchase: string
      petHoldRevoked: string
      petHoldOffline: string
      openStore: string
      fromAtum: string
      popular: string
      results: string
      hatchTitle: string
      hatchLead: string
      hatchBody: string
      hatchAction: string
      meetTitle: (pet: string) => string
      meetBody: string
      wave: string
      jump: string
      sit: string
      lounge: string
      walk: string
      hatching: string
      hatched: (pet: string, assistant: string) => string
    }
    productTitle: string
    nav: {
      aria: string
      relaunchUpdate: string
      /** The nav switch on the top row: Home / Discover / Workplace. */
      launcher: string
      home: string
      discover: string
      /** Workplace is drawn in the launcher, disabled, with this as its tip. */
      workplaceSoon: string
      settings: string
      account: string
      usage: string
    }
    account: {
      editProfile: string
      copyId: string
      menu: string
      /** Footer menu rows, Codex-shaped: usage, the pet (coming soon), invite. */
      pet: string
      invite: string
      signedOut: string
      language: string
      theme: string
      title: string
      description: string
      name: string
      username: string
      email: string
      phone: string
      id: string
      unavailable: string
      editUnavailable: string
      editUsername: string
      handleHint: string
      handleAvailable: string
      handleInvalid: string
      handleTaken: string
      handleReserved: string
      handleCooldown: string
      handleChecking: string
      handleFailed: string
      handleSave: string
      handleClaimed: (handle: string) => string
      handleClaimedHint: string
      /** The typed username is already this account's. */
      handleCurrent: string
      /** When the next username change is allowed. */
      handleNextChange: (date: string) => string
      editName: string
      nameHint: string
      nameSave: string
      nameFailed: string
      photo: string
      changePhoto: string
      removePhoto: string
      photoHint: string
      photoUploading: string
      photoTooLarge: string
      photoWrongType: string
      photoFailed: string
      linkedApps: string
      linkedAppsEmpty: string
      linkedAppsFailed: string
      disconnect: string
      disconnectConfirm: (app: string) => string
      disconnectHint: string
      disconnectComplete: string
      disconnectPending: string
      disconnectLocalPending: string
      retryLocalCleanup: string
      disconnectFailed: string
      interactionPermissions: string
      interactionPermissionsHint: string
      interactionPermissionsEmpty: string
      interactionPermissionsFailed: string
      revokePermission: string
      consentAlwaysAllowed: string
      /** Shown when Hermes approvals are off for the active profile: nothing asks. */
      approvalsOff: string
      consent: {
        browser: string
        computerObserve: string
        computerControl: string
        workspaceWrite: string
      }
    }
    settings: {
      advancedPage: {
        modelsTitle: string
        catalogUnavailable: string
        providersTitle: string
        modelSaveFailed: string
        modelsUnavailable: string
        description: string
        scope: string
        manage: string
        choose: string
        open: string
        providersDescription: string
        modelDescription: string
        systemDescription: string
      }
      accountDescription: string
      title: string
      description: string
      general: string
      advanced: string
      systemConfiguration: string
      appearance: string
      appearanceDescription: string
      textSize: string
      textSizeDescription: string
      model: string
      speed: string
      standard: string
      useDefault: string
      advancedOptions: string
      modelDescription: string
      notifications: string
      usage: string
      about: string
      account: string
      back: string
    }
    composer: {
      modelFast: string
      modelBalanced: string
      modelDeep: string
      modelChoose: string
      modelDefault: string
      modelDefaultDescription: string
      modelFaster: string
      modelSmarter: string
      modelUnavailable: string
      placeholderFor: (name: string) => string
    }
    startup: {
      opening: string
    }
    agents: {
      /** Label of the full-width button that closes the assistants section. */
      create: string
      createTitle: string
      createBody: string
      nameLabel: string
      namePlaceholder: string
      nameRequired: string
      /** Names must fit the hosted assistant registry; legacy names can be renamed here. */
      nameTooLong: string
      avatarLabel: string
      photoLabel: string
      changePhoto: string
      removePhoto: string
      photoHint: string
      photoUploading: (progress: number) => string
      photoTooLarge: string
      photoWrongType: string
      photoFailed: string
      photoRetry: string
      /** The assistant's pet — its face on the desktop, picked here like the photo. */
      petLabel: string
      petChoose: string
      petChange: string
      petNone: string
      petSearch: string
      petNoMatch: (query: string) => string
      petUnreachable: string
      petFailed: string
      changedElsewhere: string
      visibilityLabel: string
      visibilityPrivate: string
      visibilityPublicSoon: string
      personaLabel: string
      personaPlaceholder: string
      jobLabel: string
      jobPlaceholder: string
      submit: string
      creating: string
      failed: string
      /** Per-agent row controls. */
      newChat: string
      more: string
      edit: string
      editTitle: string
      editBody: string
      /** Shown instead of the persona/job boxes when the instructions were hand-written. */
      instructionsCustom: string
      save: string
      saving: string
      editFailed: string
      sync: string
      retrySync: string
      syncFailed: string
      applyCloudVersion: string
      applyCloudHint: string
      applyCloudFailed: string
      syncConflict: string
      discardLocalDraft: string
      setupHere: string
      checkThisComputer: string
      sourceDefinitionMissing: string
      sourceComputerNeeded: string
      setupFailed: string
      missingSkills: string
      pin: string
      unpin: string
      reorder: string
      showChats: (count: number) => string
      hideChats: string
    }
    roster: {
      createMenu: string
      startChat: string
      startChatHint: string
      startChatSearch: string
      people: string
      apps: string
      addFriends: string
      pinLimit: string
      title: string
      search: string
      searchPlaceholder: string
      searching: string
      channels: string
      messages: string
      files: string
      assistant: string
      assistantHint: string
      /** The "new conversation" row under the search field. */
      newChat: string
      /** Section label over the hosted specialists. */
      specialists: string
      /** Section label over the user's own assistants. */
      assistants: string
      /** Row title for a chat the server has not titled or previewed yet. */
      untitledChat: string
      /** Attention label when a chat's turn finished while the user was elsewhere. */
      finished: string
      /** Fold control under the pinned assistant once it has more chats than the roster shows. */
      showMoreChats: (count: number) => string
      showFewerChats: string
      badgeFirstParty: string
      badgePartner: string
      badgeFirstPartyShort: string
      badgePartnerShort: string
      signedOutTitle: string
      signedOutBody: string
      signIn: string
      retry: string
      emptyChats: string
      unread: (count: number) => string
      results: (count: number) => string
      /** Drag handle that sets the roster's width. */
      resize: string
      emptySearch: string
      emptySearchHint: string
      /** Zero-result escape hatch: sends the person to Discover. */
      emptySearchDiscover: string
      loadFailed: string
      openAppFailed: string
      verified: string
    }
    discover: {
      trainAnother: string
      trainingRetryActivate: string
      trainingFor: (name: string) => string
      trainingPerAgent: string
      trained: string
      trainedEmpty: string
      /** Rail label and page title for the Discover surface. */
      title: string
      subtitle: string
      /** Shelf switcher aria-label: one storefront, one shelf at a time. */
      shelvesAria: string
      featuredSection: string
      /** Agents-for-hire shelf: drawn and labelled but disabled — the platform
       *  has no browse endpoint, so the tab gets a tip and is never clickable. */
      agentsSection: string
      agentsSoon: string
      skillsSection: string
      appsSection: string
      peopleSection: string
      /** States plainly that people are found by exact @name, not browsed. */
      peopleHint: string
      placeholder: string
      tooShort: string
      searchAtum: string
      searching: string
      none: string
      failed: string
      rateLimited: (seconds: number) => string
      signedOut: string
      appsEmpty: string
      appsStale: string
      comingSoon: string
      free: string
      unavailable: string
      open: string
      try: string
      tryAgain: string
      add: string
      added: string
      addedFor: (name: string) => string
      addedForOthers: (name: string, count: number) => string
      addTitle: (skill: string) => string
      installFailedRetry: string
      installFailedFor: (name: string) => string
      newChatOnly: string
      needsNothing: string
      needsInternet: string
      needsScripts: string
      tryExample: (prompt: string) => string
      filesIncluded: string
      previewLoading: string
      installedAssistants: string
      noInstalledAssistants: string
      refreshFailed: string
      /** Pets in Discover: browse the catalog, adopt for a named assistant. */
      petsSection: string
      petsIntro: string
      /** A shelf's link out to where what you already have is managed —
       *  acquiring lives in the store, managing stays where it is. */
      manageInstalled: string
      adopt: string
      adoptTitle: (pet: string) => string
      adoptFor: string
      adoptedFor: (name: string) => string
      adoptFailed: string
      browsePets: string
      connect: string
      accept: string
      block: string
      decline: string
      unblock: string
      openChat: string
      /** The Atum Store's prices and ownership (plan 2026-09-10-atum-store.md).
       *  A priced pill reads `protons`; Owned means an entitlement exists, and
       *  the Owned chip narrows a shelf to exactly those rows. */
      protons: (amount: string) => string
      owned: string
      /** The Owned filter with nothing owned yet. */
      ownedEmpty: string
      /** Purchase succeeded but the install failed: retry installs, never buys again. */
      ownedRetryInstall: string
      storeSignedOut: string
      storeUnavailable: string
      catalogLoading: string
      catalogStale: string
      /** The purchase confirm: the authoritative offer, its version, and the
       *  wallet's available Protons as main returned them. */
      buyFor: (price: string) => string
      availableBalance: (balance: string) => string
      offerChanged: string
      insufficientProtons: string
      topUp: string
      purchaseFailed: string
      purchaseUnavailable: string
      purchaseUncertain: string
      checkPurchase: string
    }
    empty: {
      /** Starter chips: summarize/today insert their prompt; openFile and
       *  moon are typed navigation actions — the local assistant has no tools
       *  to perform them from text. */
      chips: {
        summarize: string
        openFile: string
        moon: string
        today: string
      }
    }
    welcome: {
      promise: string
      castLabel: string
      skipHint: string
    }
    permissions: {
      later: string
      allow: string
      openSettings: string
      notifications: {
        title: string
        body: string
        denied: string
      }
      files: {
        title: string
        body: (name: string) => string
        denied: (name: string) => string
        chooseAnother: string
      }
    }
    chat: {
      none: string
      noneHint: string
      openRoster: string
      closeRoster: string
      openSidebar: string
      closeSidebar: string
      /** One-line description under the master assistant's name in the chat header. */
      assistantTagline: string
      /** The chat header's only menu. */
      more: string
      newChat: string
      archiveChat: string
      /** Collapsed tool-step row: "Worked for 1m 12s". */
      workedFor: (duration: string) => string
      /** Fallback for the same row when no timing was reported. */
      workedSteps: (count: number) => string
    }
    workspace: {
      mainWindowOnly: string
      title: string
      open: string
      close: string
      none: string
      resize: string
      tabView: string
      tabFiles: string
      tabDetails: string
      completionComplete: string
      completionFailed: string
      launcherTab: string
      launcherAdd: string
      launcherClose: string
      launcherTitle: string
      launcherBody: string
      launcherFiles: string
      launcherFilesBody: string
      launcherFilesAction: string
      launcherTools: string
      launcherUtilities: string
      launcherSearch: string
      launcherOpenFile: string
      launcherOpenBeside: string
      launcherOpenNormally: string
      launcherActionFailed: string
      launcherNoResults: string
      launcherChooseWindow: string
      launcherBeside: string
      launcherOpened: string
      launcherReasonPermission: string
      launcherOpenAccessibilitySettings: string
      launcherReasonNoWindow: string
      launcherReasonUnsupported: string
      launcherReasonFullscreen: string
      launcherReasonLayoutFailed: string
      launcherNoLiveContext: string
      launcherSavedFileContext: string
      launcherSavedFileUnavailable: string
      capability: {
        acquireDetail: string
        actionFailed: string
        addToAssistant: string
        ambiguousDetail: string
        browseSkills: string
        capabilityForApp: string
        capabilityForSkill: string
        close: string
        disabledDetail: string
        enableForAssistant: string
        includedDetail: string
        limitations: string
        needsSetupDetail: string
        noSupportedSkill: string
        openApp: string
        openBeside: string
        openNormally: string
        operationCreate: string
        operationEdit: string
        operationFileVisible: string
        operationNeedsSetup: string
        operationRead: string
        operationReady: string
        operationRenderQa: string
        operationUnknown: string
        operationValidate: string
        statusReadReady: string
        readReadyDetail: string
        readyDetail: string
        reasonFileVisibility: string
        reasonMissingTools: string
        reasonRemoteRuntime: string
        reasonVisualQa: string
        recheck: string
        setup: string
        setupRequest: string
        skillOnly: string
        statusAcquire: string
        statusAmbiguous: string
        statusChecking: string
        statusDisabled: string
        statusIncluded: string
        statusNeedsSetup: string
        statusReady: string
        statusUnavailable: string
        statusUnsupported: string
        unavailableDetail: string
        unknownCapability: string
        useSkill: string
      }
      launcherBrowser: string
      launcherBrowserBody: string
      launcherComingSoon: string
      /** App-launcher placeholders: drawn greyed with launcherComingSoon. */
      toolSheet: string
      toolSlides: string
      toolDesign: string
      /** The workspace tab bar's expand control (mock 1a). */
      expand: string
      /** The same control once the panel fills the frame: the way back. */
      collapse: string
      importWordSuccess: string
      importWordTooLarge: string
      importWordTruncated: string
      importWordInvalid: string
      importWordFailed: string
      empty: string
      detailsConversation: string
      detailsParticipants: string
      detailsUpdated: string
      detailsDeveloper: string
      detailsType: string
      detailsTypeFirstParty: string
      detailsVerified: string
      detailsYes: string
      detailsPermissions: string
      detailsPermissionUserInfo: string
      filesBack: string
      filesUp: string
      filesRoot: string
      filesView: string
      filesGrid: string
      filesList: string
      filesLoading: string
      filesEmpty: string
      filesError: string
      filesOpenError: string
      filesRetry: string
      filesNoFolder: string
      filesNoFolderHint: string
      filesNoBridge: string
      filesWorkFolder: string
      filesForward: string
      filesSearch: string
      filesSearching: string
      filesNoResults: string
      filesSearchTruncated: string
      filesPlaces: string
      filesHome: string
      filesDesktop: string
      filesDocuments: string
      filesDownloads: string
      filesColumnName: string
      filesColumnModified: string
      filesColumnSize: string
      filesOpen: string
      filesOpenNative: string
      filesReveal: string
      filesRename: string
      filesTrash: string
      filesRenameError: string
      filesTrashError: string
      filesOpenedNative: string
      wordOpening: string
      wordCompanionLabel: string
      wordLiveContext: string
      wordExit: string
      wordCancel: string
      wordDismiss: string
      wordMissing: string
      wordPermission: string
      wordFullscreen: string
      wordSmallScreen: string
      wordOpenError: string
      wordDocumentUnavailable: string
      filesFolderKind: string
      filesItemCount: (count: number) => string
      filesNewFolder: string
      filesNewFolderName: string
      filesNewFolderError: string
      filesPdfViewer: string
      filesPdfFailed: string
      documentEdit: string
      documentTabs: string
      documentClose: string
      documentReopen: string
      documentLoading: string
      documentDenied: string
      documentMissing: string
      documentThrottled: string
      documentFeatureUnavailable: string
      documentTemporarilyUnavailable: string
      documentTooLarge: string
      documentRetry: string
    }
    appView: {
      title: string
      loading: string
      retry: string
      reconnect: string
      connect: string
      notLinked: string
      unlinked: string
      membershipInactive: string
      appUnavailable: string
      versionIncompatible: string
      securityFailure: string
      loadFailed: string
      temporarilyUnavailable: string
      rateLimited: string
      accountUnavailable: string
      invalid: string
    }
    browser: {
      address: string
      back: string
      blockedBody: string
      blockedTitle: string
      downloadRefused: string
      downloadBusy: string
      downloadFailed: string
      errorBody: string
      errorTitle: string
      forward: string
      insecure: string
      loading: string
      newTab: string
      openInBrowser: string
      reload: string
      retry: string
      stop: string
      title: string
    }
    auth: {
      title: string
      expiredTitle: string
      expiredBody: string
      terms: string
    }
    usernameGate: {
      title: string
      body: string
      label: string
      cooldownNote: string
      save: string
      keep: (handle: string) => string
      saved: (handle: string) => string
    }
    offline: {
      banner: string
      reconnecting: string
      reconnected: string
    }
    managedModel: {
      stopTask: string
      cancelFailed: string
      trainingCancelled: string
      trainingChanged: string
      trainingUnavailable: string
      trainingUnverified: string
      insufficient_funds: string
      service_paused: string
      model_unavailable: string
      addProtons: string
      title: string
      details: string
      recentTurns: string
      noTurns: string
      turnsUnavailable: string
      turnCalls: (calls: number) => string
      turnTokens: (prompt: string, completion: string) => string
      turnStatus: {
        reserved: string
        dispatched: string
        settled: string
        reconciliation_pending: string
        expired: string
        corrected: string
        revoked: string
      }
      checking: string
      denied: string
      funding_required: string
      model_reserved: string
      authentication_expired: string
      unavailable: string
      retry: string
      slow: string
    }
    protons: {
      description: string
      checkout: {
        buy: string
        vndInline: (amount: string) => string
        qrHeading: string
        qrNote: string
        qrAlt: string
        downloadQr: string
        qrUnavailable: string
        qrUnavailableCheckout: string
        openCheckoutPage: string
        amount: string
        bank: string
        accountNumber: string
        accountName: string
        transferNote: string
        copy: string
        copied: string
        copyManual: string
        copyDetail: (label: string) => string
        expiresIn: string
      }
      rewards: {
        title: string
        hint: string
        email: string
        calendar: string
        verify: string
        verifying: string
        earned: string
        paused: string
        unavailable: string
        failed: string
        alreadyUsed: string
      }
      title: string
      balance: (amount: string) => string
      balanceUnavailable: string
      checking: string
      available: string
      held: string
      purchaseTerms: string
      unavailable: string
    }
  }

  fileMenu: {
    revealFinder: string
    revealExplorer: string
    revealFileManager: string
    revealInSidebar: string
    copyPath: string
    copyRelativePath: string
    rename: string
    delete: string
    renameTitle: string
    renameLabel: string
    deleteTitle: (name: string) => string
    deleteBody: string
    pathCopied: string
  }

  boot: {
    ready: string
    desktopBootFailedWithMessage: (message: string) => string
    steps: {
      connectingGateway: string
      loadingSettings: string
      loadingSessions: string
      startingDesktopConnection: string
      startingHermesDesktop: string
    }
    errors: {
      backgroundExited: string
      backgroundExitedDuringStartup: string
      backendStopped: string
      desktopBootFailed: string
      gatewayConnectionLost: string
      gatewaySignInRequired: string
      ipcBridgeUnavailable: string
    }
    failure: {
      title: string
      description: string
      consumerDescription: string
      collectDiagnostics: string
      diagnosticsHint: string
      remoteTitle: string
      remoteDescription: string
      retry: string
      repairInstall: string
      useLocalGateway: string
      gatewaySettings: string
      back: string
      openLogs: string
      repairHint: string
      remoteSignInHint: (signInLabel: string) => string
      signOutAndSignIn: string
      remoteFailureHint: string
      hideRecentLogs: string
      showRecentLogs: string
      signedInTitle: string
      signedInMessage: string
      signInIncompleteTitle: string
      signInIncompleteMessage: string
      signInFailed: string
      signInToRemoteGateway: string
      signInWithProvider: (provider: string) => string
      identityProvider: string
    }
  }

  notifications: {
    region: string
    hide: string
    show: string
    more: (count: number) => string
    clearAll: string
    dismiss: string
    details: string
    copyDetail: string
    copyDetailFailed: string
    backendOutOfDateTitle: string
    backendOutOfDateMessage: string
    installMethodUnsupportedTitle: string
    updateHermes: string
    updateReadyTitle: string
    updateReadyMessage: (count: number) => string
    seeWhatsNew: string
    errors: {
      elevenLabsNeedsKey: string
      elevenLabsRejectedKey: string
      gatewayAuthFailed: string
      methodNotAllowed: string
      microphonePermission: string
      openaiRejectedApiKey: string
      openaiRejectedApiKeyWithStatus: (status: string) => string
      openaiTtsNeedsKey: string
    }
    voice: {
      configureSpeechToText: string
      couldNotStartSession: string
      microphoneAccessDenied: string
      microphoneConstraintsUnsupported: string
      microphoneFailed: string
      microphoneInUse: string
      microphonePermissionDenied: string
      microphoneStartFailed: string
      microphoneUnsupported: string
      noMicrophone: string
      noSpeechDetected: string
      playbackFailed: string
      recordingFailed: string
      transcriptionFailed: string
      transcriptionUnavailable: string
      tryRecordingAgain: string
      unavailable: string
    }
    // Native OS notification copy (titles + generic fallback bodies). Dynamic
    // bodies (the agent's reply, a command, an error) are passed through raw.
    native: {
      approvalTitle: string
      approveAction: string
      rejectAction: string
      inputTitle: string
      inputBody: string
      turnDoneTitle: string
      turnDoneBody: string
      turnErrorTitle: string
      backgroundDoneTitle: string
      backgroundFailedTitle: string
      creditsTitle: string
    }
  }

  remoteDisplayBanner: {
    message: (reason: string) => string
  }

  billingBlock: {
    titleNous: string
    titleProvider: (provider: string) => string
    fallbackMessage: string
    openBilling: string
    addCredits: string
    dismiss: string
  }

  titlebar: {
    hideSidebar: string
    showSidebar: string
    search: string
    searchTitle: string
    swapSidebarSides: string
    swapSidebarSidesTitle: string
    hideRightSidebar: string
    showRightSidebar: string
    muteHaptics: string
    unmuteHaptics: string
    openSettings: string
    openStarmap: string
    openKeybinds: string
    layoutEditor: string
    layoutEditorTitle: string
  }

  keybinds: {
    title: string
    subtitle: (open: string) => string
    search: string
    rebind: string
    reset: string
    resetAll: string
    pressKey: string
    set: string
    conflictWith: (label: string) => string
    categories: Record<string, string>
    actions: Record<string, string>
  }

  language: {
    label: string
    description: string
    saving: string
    saveError: string
    switchTo: string
    searchPlaceholder: string
    noResults: string
  }

  settings: {
    reporting: {
      preferenceFailed: string
      title: string
      notice: string
      unavailable: string
      diagnosticId: string
      feedback: string
      feedbackHint: string
      send: string
      sending: string
      sent: string
      failed: string
      helpful: string
      notHelpful: string
    }
    closeSettings: string
    exportConfig: string
    importConfig: string
    resetToDefaults: string
    resetConfirm: string
    exportFailed: string
    resetFailed: string
    nav: {
      providers: string
      providerAccounts: string
      providerApiKeys: string
      providerCustomEndpoints: string
      gateway: string
      apiKeys: string
      keybinds: string
      keysTools: string
      keysSettings: string
      mcp: string
      archivedChats: string
      about: string
      billing: string
      notifications: string
      plugins: string
    }
    plugins: {
      title: string
      blurb: string
      count: (n: number) => string
      openFolder: string
      rescan: string
      reveal: string
      enable: string
      disable: string
      failed: string
      empty: string
      kinds: { bundled: string; disk: string; runtime: string }
    }
    notifications: {
      title: string
      intro: string
      enableAll: string
      enableAllDesc: string
      focusedHint: string
      kinds: Record<
        'approval' | 'backgroundDone' | 'credits' | 'input' | 'turnDone' | 'turnError',
        { label: string; description: string }
      >
      test: string
      testTitle: string
      testBody: string
      testSent: string
      testUnsupported: string
      completionSoundTitle: string
      completionSoundDesc: string
      completionSoundPreview: string
    }
    sections: Record<string, string>
    searchPlaceholder: Record<'about' | 'config' | 'gateway' | 'keys' | 'mcp' | 'sessions', string>
    modeOptions: Record<'light' | 'dark' | 'system', ModeOptionCopy>
    appearance: {
      title: string
      intro: string
      colorMode: string
      colorModeDesc: string
      toolViewTitle: string
      toolViewDesc: string
      uiScaleTitle: string
      uiScaleDesc: (percent: number) => string
      translucencyTitle: string
      translucencyDesc: string
      backdropTitle: string
      backdropDesc: string
      embedsTitle: string
      embedsDesc: string
      embedsAsk: string
      embedsAlways: string
      embedsOff: string
      embedsReset: (count: number) => string
      product: string
      productDesc: string
      technical: string
      technicalDesc: string
      themeTitle: string
      themeDesc: string
      themeProfileNote: (profile: string) => string
      installTitle: string
      installDesc: string
      installPlaceholder: string
      installButton: string
      installing: string
      installError: string
      installed: (name: string) => string
      removeTheme: string
      importedBadge: string
      pet: {
        title: string
        intro: string
        /** Names the assistant whose pet this page is editing. */
        scopeNote: (assistant: string) => string
        restartHint: string
        on: string
        off: string
        scaleTitle: string
        scaleDesc: string
        roamTitle: string
        roamDesc: string
        chooseTitle: string
        chooseDesc: string
        searchPlaceholder: string
        unreachable: string
        noMatch: (query: string) => string
        installedTag: string
        generatedTag: string
        countCapped: (cap: number, total: number) => string
        count: (n: number) => string
        uninstall: (name: string) => string
        delete: (name: string) => string
        deleteTitle: (name: string) => string
        deleteBody: string
        deleteConfirm: string
        rename: (name: string) => string
        renameTitle: string
        renamePlaceholder: string
        renameSave: string
        exportPet: (name: string) => string
        adoptFailed: (slug: string) => string
        uninstallFailed: (slug: string) => string
        renameFailed: (slug: string) => string
        exportFailed: (slug: string) => string
        noneAvailable: string
        turnOnFailed: string
        turnOffFailed: string
        /** Settings manages the pets you have; Discover is where you find one. */
        yourPetsTitle: string
        yourPetsDesc: string
        browseDiscover: string
      }
    }
    fieldLabels: Record<string, string>
    fieldDescriptions: Record<string, string>
    about: {
      heading: string
      version: (value: string) => string
      versionUnavailable: string
      updates: string
      checkNow: string
      checking: string
      seeWhatsNew: string
      updateNow: string
      releaseNotes: string
      onLatest: string
      installing: string
      cantUpdate: string
      cantReach: string
      tapCheck: string
      updateReady: (count: number) => string
      lastChecked: (age: string) => string
      justNowSuffix: string
      automaticUpdates: string
      updateDownloading: string
      updateDownloaded: string
      updateWaitForWork: string
      automaticUpdatesDesc: string
      branchCommit: (branch: string, commit: string) => string
      never: string
      justNow: string
      minAgo: (count: number) => string
      hoursAgo: (count: number) => string
      daysAgo: (count: number) => string
    }
    config: {
      none: string
      noneParen: string
      builtinOnly: string
      notSet: string
      commaSeparated: string
      loading: string
      emptyTitle: string
      emptyDesc: string
      failedLoad: string
      autosaveFailed: string
      imported: string
      invalidJson: string
      keepAwakeTitle: string
      keepAwakeDesc: string
    }
    credentials: {
      pasteKey: string
      pasteLabelKey: (label: string) => string
      optional: string
      enterValueFirst: string
      couldNotSave: string
      remove: string
      getKey: string
      saving: string
    }
    envActions: {
      actionsFor: (label: string) => string
      credentialActions: string
      manageInKeys: string
      docs: string
      hideValue: string
      revealValue: string
      replace: string
      set: string
      clear: string
    }
    gateway: {
      loading: string
      unavailableTitle: string
      unavailableDesc: string
      title: string
      envOverride: string
      intro: string
      appliesTo: string
      allProfiles: string
      defaultConnection: string
      profileConnection: (profile: string) => string
      envOverrideTitle: string
      envOverrideDesc: string
      modeTitle: string
      localTitle: string
      localDesc: string
      remoteTitle: string
      remoteDesc: string
      remoteAuthHint: string
      cloudTitle: string
      cloudDesc: string
      cloudSignInTitle: string
      cloudSignIn: string
      cloudSignedIn: string
      cloudNeedsSignIn: string
      cloudSignedInDesc: string
      cloudAgentsTitle: string
      cloudOrgPickerTitle: string
      cloudOrgSelect: string
      cloudOrgChange: string
      cloudOrgRole: (role: string) => string
      cloudLoadingAgents: string
      cloudNoAgents: { before: string; linkText: string; after: string }
      cloudRefresh: string
      cloudConnect: string
      cloudConnecting: string
      cloudDiscoverFailed: string
      cloudConnectFailed: string
      cloudSignInFailed: string
      cloudSignedOutTitle: string
      cloudSignedOutMessage: string
      cloudConnectedTitle: string
      cloudConnectedPill: string
      cloudConnectedTo: (name: string) => string
      cloudAgentProvisioning: string
      cloudStatusLabel: (status: string) => string
      remoteUrlTitle: string
      remoteUrlDesc: string
      probing: string
      probeError: string
      signedIn: string
      signIn: string
      signOut: string
      signInWith: (provider: string) => string
      authTitle: string
      authSignedInPassword: string
      authSignedInOauth: string
      authNeedsPassword: string
      authNeedsOauth: (provider: string) => string
      tokenTitle: string
      tokenDesc: string
      existingToken: (value: string) => string
      savedToken: string
      pasteSessionToken: string
      testRemote: string
      saveForRestart: string
      saveAndReconnect: string
      diagnostics: string
      diagnosticsDesc: string
      openLogs: string
      incompleteTitle: string
      incompleteSignIn: string
      incompleteToken: string
      incompleteSignInTest: string
      incompleteTokenTest: string
      enterUrlFirst: string
      restartingTitle: string
      savedTitle: string
      restartingMessage: string
      savedMessage: string
      connectedTo: (baseUrl: string, version?: string) => string
      reachableTitle: string
      signedOutTitle: string
      signedOutMessage: string
      failedLoad: string
      signInFailed: string
      signOutFailed: string
      testFailed: string
      applyFailed: string
      saveFailed: string
      sshTitle: string
      sshDesc: string
      sshTrustHint: string
      sshHostTitle: string
      sshHostDesc: string
      sshHostPick: string
      sshHostPickTitle: string
      sshHostPickDesc: string
      sshHostCustom: string
      sshUserTitle: string
      sshUserDesc: string
      sshUserPlaceholder: string
      sshPortTitle: string
      sshPortDesc: string
      sshKeyTitle: string
      sshKeyDesc: string
      sshHermesPathTitle: string
      sshHermesPathDesc: string
      sshHermesPathPlaceholder: string
      sshTestConnection: string
      sshConnect: string
      sshButtonsHint: string
      sshReachable: (host: string, platform: string) => string
      sshIncompleteHost: string
      sshErrUnreachable: string
      sshErrAuth: string
      sshErrHostKey: string
      sshErrNotInstalled: string
      sshErrPlatform: string
      sshErrTimeout: string
      sshErrUpdateRequired: string
      sshErrUnknown: string
    }
    keys: {
      loading: string
      failedLoad: string
      empty: string
    }
    mcp: {
      loading: string
      failedLoad: string
      nameRequiredTitle: string
      nameRequiredMessage: string
      objectRequired: string
      invalidJson: string
      saveFailed: string
      removeFailed: string
      gatewayUnavailableTitle: string
      gatewayUnavailableMessage: string
      reloadedTitle: string
      reloadedMessage: string
      reloadFailed: string
      savedTitle: string
      savedMessage: (name: string) => string
      newServer: string
      reload: string
      reloading: string
      emptyTitle: string
      emptyDesc: string
      disabled: string
      editServer: string
      name: string
      serverJson: string
      remove: string
      saveServer: string
      test: string
      testing: string
      testOk: (count: number) => string
      testFailed: string
      enableServer: (name: string) => string
      disableServer: (name: string) => string
      serverEnabled: (name: string) => string
      serverDisabled: (name: string) => string
      toggleFailed: (name: string) => string
      tabServers: string
      tabCatalog: string
      catalogLoading: string
      catalogLoadFailed: string
      catalogEmpty: string
      catalogInstalled: string
      catalogEnabled: string
      catalogNeedsInstall: string
      catalogInstall: string
      catalogInstalling: string
      catalogInstallStarted: (name: string) => string
      catalogInstallFailed: (name: string) => string
      catalogEnvPrompt: (name: string) => string
      catalogEnvRequired: string
      capabilitySummary: (tools: number, prompts: number, resources: number) => string
      statusConnecting: string
      statusNeedsAuth: string
      statusError: string
      statusOff: string
      allServers: string
      authenticatedTitle: string
      authenticatedMessage: (server: string, count: number) => string
      waitingForBrowser: string
      authenticate: string
      unsavedConnect: string
      enableTool: (tool: string) => string
      disableTool: (tool: string) => string
      noOutput: string
    }
    model: {
      loading: string
      appliesDesc: string
      provider: string
      model: string
      applying: string
      defaultsLabel: string
      reasoning: string
      reasoningOff: string
      defaultsFailed: string
      auxiliaryTitle: string
      resetAllToMain: string
      auxiliaryDesc: string
      setToMain: string
      change: string
      autoUseMain: string
      providerDefault: string
      fallbackAdd: string
      fallbackEmpty: string
      notInCatalog: string
      tasks: Record<string, AuxTaskCopy>
    }
    providers: {
      connectAccount: string
      haveApiKey: string
      intro: string
      connected: string
      collapse: string
      connectAnother: string
      otherProviders: string
      disconnect: string
      disconnectInTerminal: string
      removeConfirm: (provider: string) => string
      removeExternalGeneric: (provider: string) => string
      removeKeyManaged: (provider: string) => string
      removeTerminalConfirm: (provider: string, command: string) => string
      removeTerminalRunning: (provider: string) => string
      removedTitle: string
      removedMessage: (provider: string) => string
      failedRemove: (provider: string) => string
      noProviderKeys: string
      searchKeys: string
      noKeysMatch: string
      localEndpoint: {
        title: string
        description: string
      }
      loading: string
    }
    sessions: {
      loading: string
      archivedTitle: string
      archivedIntro: string
      emptyArchivedTitle: string
      emptyArchivedDesc: string
      unarchive: string
      deletePermanently: string
      messages: (count: number) => string
      restored: string
      deleteConfirm: (title: string) => string
      defaultDirTitle: string
      defaultDirDesc: string
      defaultDirUpdated: string
      defaultsTo: (label: string) => string
      change: string
      choose: string
      clear: string
      notSet: string
      failedLoad: string
      unarchiveFailed: string
      deleteFailed: string
      updateDirFailed: string
      clearDirFailed: string
    }
    toolsets: {
      loadingConfig: string
      savedTitle: string
      savedMessage: (key: string) => string
      removedTitle: string
      removedMessage: (key: string) => string
      failedSave: (key: string) => string
      failedRemove: (key: string) => string
      failedReveal: (key: string) => string
      removeConfirm: (key: string) => string
      set: string
      notSet: string
      selectedTitle: string
      selectedMessage: (provider: string) => string
      failedSelect: (provider: string) => string
      failedLoad: string
      noProviderOptions: string
      noProviders: string
      ready: string
      needsSignIn: string
      needsSetup: string
      nousIncluded: string
      nousAuthNeededTitle: string
      nousAuthNeededMessage: (provider: string) => string
      nousAuthSignIn: string
      nousAuthDoneTitle: string
      nousAuthDoneMessage: string
      nousAuthFailed: string
      noApiKeyRequired: string
      postSetupHint: (step: string) => string
      postSetupInstalledHint: string
      postSetupRun: string
      postSetupRerun: string
      postSetupInstalled: string
      postSetupRunning: string
      postSetupStarting: string
      postSetupCompleteTitle: string
      postSetupCompleteMessage: (step: string) => string
      postSetupErrorTitle: string
      postSetupErrorMessage: (step: string) => string
      postSetupFailed: (step: string) => string
      webSearchActive: (backend: string) => string
      webExtractActive: (backend: string) => string
      webCapabilityUnset: string
      webUseForSearch: string
      webUseForExtract: string
      webUsedForSearch: string
      webUsedForExtract: string
      webCapabilitySelectedMessage: (provider: string, capability: string) => string
      failedSelectCapability: (provider: string) => string
      loadingModels: string
      modelSectionTitle: string
      modelCount: (count: number) => string
      modelInUse: string
      modelDefault: string
      modelInactiveHint: string
      modelSelectedTitle: string
      modelSelectedMessage: (model: string) => string
      failedSelectModel: (model: string) => string
      terminalBackend: {
        sectionTitle: string
        loading: string
        failedLoad: string
        ready: string
        needsSetup: string
        unavailable: string
        inUse: string
        selectedTitle: string
        selectedMessage: (backend: string) => string
        failedSelect: (backend: string) => string
        needsSetupHint: string
      }
    }
  }

  skills: {
    tabSkills: string
    tabToolsets: string
    tabMcp: string
    tabHub: string
    all: string
    searchSkills: string
    searchToolsets: string
    refresh: string
    refreshing: string
    loading: string
    noSkillsTitle: string
    noSkillsDesc: string
    noToolsetsTitle: string
    noToolsetsDesc: string
    noDescription: string
    configured: string
    needsKeys: string
    visionModelHint: string
    visionModelLink: string
    toolsetsEnabled: (enabled: number, total: number) => string
    configureToolset: (label: string) => string
    toggleToolset: (label: string) => string
    skillsLoadFailed: string
    toolsetsRefreshFailed: string
    skillEnabled: string
    skillDisabled: string
    toolsetEnabled: string
    toolsetDisabled: string
    appliesToNewSessions: (name: string) => string
    failedToUpdate: (name: string) => string
    sortMostUsed: string
    sortAlpha: string
    sortMostUsedDesc: string
    sortLeastUsedAsc: string
    enableAll: string
    disableAll: string
    disableUnused: string
    bulkUpdated: (count: number) => string
    bulkNoChange: string
    usageCount: (count: number | string) => string
    provenance: Record<'agent' | 'bundled' | 'hub', string>
    emptyNoneFound: (noun: string) => string
    emptyNothingMatches: (query: string) => string
    emptyNoneAvailable: (noun: string) => string
    changesApplyNewSessions: string
    skillUpdated: string
    edit: string
    archive: string
    skillArchivedTitle: string
    skillArchivedMessage: string
    hub: {
      searchPlaceholder: string
      search: string
      searching: string
      connectingHubs: string
      connectedHubs: string
      featured: string
      landingHint: string
      noResults: string
      resultCount: (count: number, ms: number | null) => string
      timedOut: (sources: string) => string
      installed: string
      install: string
      installing: string
      uninstall: string
      uninstalling: string
      update: string
      updateAll: string
      updating: string
      preview: string
      scan: string
      scanning: string
      close: string
      files: string
      noReadme: string
      trust: Record<string, string>
      verdictSafe: string
      verdictCaution: string
      verdictDangerous: string
      policyAllow: string
      policyAsk: string
      policyBlock: string
      findings: (count: number) => string
      noFindings: string
      installStarted: (name: string) => string
      uninstallStarted: (name: string) => string
      updateStarted: string
      actionFailed: string
      actionLog: string
      loadFailed: string
      previewFailed: string
      scanFailed: string
      searchFailed: string
    }
  }

  starmap: {
    title: string
    subtitle: (nodes: number, clusters: number) => string
    close: string
    refresh: string
    memory: string
    filterAll: string
    filterUsed: string
    filterLearned: string
    viewGraph: string
    loadFailed: string
    loading: string
    emptyTitle: string
    emptyDesc: string
    share: string
    shareHint: string
    shareTitle: string
    sharePlaceholder: string
    copy: string
    copied: string
    importMap: string
    importBtn: string
    importEmpty: string
    importSuccess: (nodes: number) => string
    importedBadge: string
    resetToMine: string
  }
  agents: {
    close: string
    title: string
    subtitle: string
    emptyTitle: string
    emptyDesc: string
    running: string
    failed: string
    done: string
    streaming: string
    files: string
    moreFiles: (count: number) => string
    delegation: (index: number) => string
    workers: (count: number) => string
    workersActive: (count: number) => string
    agentsCount: (count: number) => string
    activeCount: (count: number) => string
    failedCount: (count: number) => string
    toolsCount: (count: number) => string
    filesCount: (count: number) => string
    updatedAgo: (age: string) => string
    ageNow: string
    ageSeconds: (seconds: number) => string
    ageMinutes: (minutes: number) => string
    ageHours: (hours: number) => string
    ageDays: (days: number) => string
    durationSeconds: (seconds: string) => string
    durationMinutes: (minutes: number, seconds: number) => string
    tokens: (value: number | string) => string
  }

  commandCenter: {
    close: string
    paletteTitle: string
    back: string
    searchPlaceholder: string
    goTo: string
    goToSession: string
    branches: string
    commands: string
    startInBranch: (branch: string) => string
    commandCenter: string
    appearance: string
    settings: string
    changeTheme: string
    changeColorMode: string
    generatePet: {
      title: string
      placeholder: string
      promptHint: string
      readyHint: string
      generate: string
      generating: string
      retry: string
      hatch: string
      spawning: string
      hatching: string
      hatchingSub: string
      hatched: string
      hatchRow: (state: string, done: number, total: number) => string
      hatchComposing: string
      hatchSaving: string
      namePlaceholder: string
      staleBackend: string
      backgroundHint: string
      slowProviderHint: string
      remix: string
      remixConfirmTitle: string
      remixConfirmBody: string
      genericError: string
      referenceImageTooLarge: string
      referenceImageInvalid: string
      adopt: string
      startOver: string
      /** The spec path (a model writes, Atum draws) vs an image model. */
      styleLabel: string
      styleVoxel: string
      styleIllustrated: string
      placeholderDog: string
      designing: string
      renderingPreviews: string
      hatchRendering: string
      hatchValidating: string
      hatchPublishing: string
      voxelUnavailableTitle: string
      voxelUnavailableBody: string
      voxelUnavailableAction: string
      byokNote: string
      errorUnsupportedAnimal: string
      errorTimeout: string
      errorUnreachable: string
      errorNoPet: string
      errorBadInput: string
      errorBilling: string
    }
    installTheme: {
      title: string
      pageTitle: string
      placeholder: string
      loading: string
      error: string
      empty: string
      install: string
      installing: string
      installed: string
      installs: (count: string) => string
    }
    settingsFields: string
    mcpServers: string
    archivedChats: string
    sections: Record<'maintenance' | 'sessions' | 'system' | 'usage', string>
    sectionDescriptions: Record<'maintenance' | 'sessions' | 'system' | 'usage', string>
    nav: Record<'newChat' | 'settings' | 'skills' | 'messaging' | 'artifacts', { title: string; detail: string }>
    sectionEntries: Record<'sessions' | 'system' | 'usage', { title: string; detail: string }>
    providerNavigate: string
    providerSessions: string
    refresh: string
    refreshing: string
    noResults: string
    pinSession: string
    unpinSession: string
    exportSession: string
    deleteSession: string
    noSessions: string
    gatewayRunning: string
    gatewayStopped: string
    hermesActiveSessions: (version: string, count: number) => string
    restartGateway: string
    gatewayRestartFailed: string
    updateHermes: string
    actionRunning: string
    actionDone: string
    actionFailed: string
    actionStartedWaiting: string
    loadingStatus: string
    recentLogs: string
    noLogs: string
    days: (count: number) => string
    statSessions: string
    statApiCalls: string
    statTokens: string
    statCost: string
    actualCost: (cost: string) => string
    loadingUsage: string
    noUsage: (period: number) => string
    retry: string
    dailyTokens: string
    input: string
    output: string
    noDailyActivity: string
    topModels: string
    noModelUsage: string
    topSkills: string
    noSkillActivity: string
    actions: (count: string) => string
    logFile: string
    logLevel: string
    logSearchPlaceholder: string
    maintenance: {
      runOps: string
      doctor: string
      doctorDesc: string
      securityAudit: string
      securityAuditDesc: string
      backup: string
      backupDesc: string
      debugShare: string
      debugShareDesc: string
      debugShareRunning: string
      debugShareLinks: string
      debugShareFailed: string
      copyLink: string
      linkCopied: string
      curator: string
      curatorDesc: string
      curatorPaused: string
      curatorActive: string
      curatorDisabled: string
      curatorLastRun: (when: string) => string
      curatorNeverRan: string
      pause: string
      resume: string
      runNow: string
      memoryData: string
      memoryDataDesc: string
      memoryProvider: (name: string) => string
      builtinMemory: string
      memoryFile: string
      userFile: string
      bytes: (size: string) => string
      empty: string
      resetMemory: string
      resetUser: string
      resetAll: string
      resetConfirm: (target: string) => string
      resetDone: (files: string) => string
      resetFailed: string
      actionStarted: (name: string) => string
      actionFailed: (name: string) => string
      running: string
      viewLog: string
    }
  }

  messaging: {
    search: string
    loading: string
    loadFailed: string
    states: Record<string, string>
    unknown: string
    hintPendingRestart: string
    hintGatewayStopped: string
    credentialsSet: string
    needsSetup: string
    gatewayStopped: string
    getCredentials: string
    openSetupGuide: string
    required: string
    recommended: string
    advanced: (count: number) => string
    noTokenNeeded: string
    enabled: string
    disabled: string
    unsavedChanges: string
    saving: string
    saveChanges: string
    saved: string
    replaceValue: string
    openDocs: string
    clearField: (key: string) => string
    enableAria: (name: string) => string
    disableAria: (name: string) => string
    platformEnabled: (name: string) => string
    platformDisabled: (name: string) => string
    restartToApply: string
    setupSaved: (name: string) => string
    restartToReconnect: string
    keyCleared: (key: string) => string
    setupUpdated: (name: string) => string
    failedUpdate: (name: string) => string
    failedSave: (name: string) => string
    failedClear: (key: string) => string
    fieldCopy: Record<string, { label?: string; help?: string; placeholder?: string }>
    platformIntro: Record<string, string>
  }

  profiles: {
    close: string
    nameHint: string
    title: string
    count: (count: number) => string
    search: string
    loading: string
    newProfile: string
    allProfiles: string
    showAllProfiles: string
    switchToProfile: (name: string) => string
    manageProfiles: string
    actionsFor: (name: string) => string
    color: string
    colorFor: (name: string) => string
    setColor: (color: string) => string
    autoColor: string
    noProfiles: string
    selectPrompt: string
    refresh: string
    refreshing: string
    default: string
    skills: (count: number) => string
    env: string
    defaultBadge: string
    rename: string
    renameMenu: string
    editSoul: string
    copySetup: string
    copying: string
    modelLabel: string
    skillsLabel: string
    notSet: string
    soulDesc: string
    soulOptional: string
    soulPlaceholder: (mode: string) => string
    soulPlaceholderCloned: string
    soulPlaceholderEmpty: string
    unsavedChanges: string
    loadingSoul: string
    emptySoul: string
    saving: string
    saveSoul: string
    deleteTitle: string
    deleteDescPrefix: string
    deleteDescMid: string
    deleteDescSuffix: string
    deleting: string
    createDesc: string
    nameLabel: string
    cloneFrom: string
    cloneFromNone: string
    cloneFromDesc: string
    cloneFromDefault: string
    cloneFromDefaultDesc: string
    invalidName: (hint: string) => string
    nameRequired: string
    creating: string
    createAction: string
    renameTitle: string
    renameDescPrefix: string
    renameDescSuffix: string
    newNameLabel: string
    renaming: string
    created: string
    renamed: string
    deleted: string
    setupCopied: string
    soulSaved: string
    failedLoad: string
    failedDelete: string
    failedCopy: string
    failedLoadSoul: string
    failedSaveSoul: string
    failedCreate: string
    failedRename: string
  }

  cron: {
    close: string
    title: string
    count: (count: number) => string
    search: string
    loading: string
    states: Record<string, string>
    deliveryLabels: Record<string, string>
    scheduleLabels: Record<string, string>
    scheduleHints: Record<string, string>
    days: Record<string, string>
    dayFallback: (value: string) => string
    everyDayAt: (time: string) => string
    weekdaysAt: (time: string) => string
    everyDayOfWeekAt: (day: string, time: string) => string
    monthlyOnDayAt: (dayOfMonth: string, time: string) => string
    topOfHour: string
    everyHourAt: (minute: string) => string
    newCron: string
    emptyDescNew: string
    emptyDescSearch: string
    emptyTitleNew: string
    emptyTitleSearch: string
    last: string
    next: string
    noRuns: string
    manage: string
    showRuns: string
    hideRuns: string
    runHistory: string
    actionsFor: (title: string) => string
    actionsTitle: string
    resume: string
    pause: string
    resumeTitle: string
    pauseTitle: string
    triggerNow: string
    edit: string
    deleteTitle: string
    deleteDescPrefix: string
    deleteDescSuffix: string
    deleting: string
    resumed: string
    paused: string
    triggered: string
    deleted: string
    created: string
    updated: string
    failedLoad: string
    failedUpdate: string
    failedTrigger: string
    failedDelete: string
    failedSave: string
    editTitle: string
    createTitle: string
    editDesc: string
    createDesc: string
    nameLabel: string
    namePlaceholder: string
    promptLabel: string
    promptPlaceholder: string
    frequencyLabel: string
    deliverLabel: string
    modelLabel: string
    modelDefault: string
    customScheduleLabel: string
    customPlaceholder: string
    customHint: string
    optional: string
    promptRequired: string
    promptScheduleRequired: string
    scheduleRequired: string
    scriptOnlyEditHint: string
    saveChanges: string
    createAction: string
  }

  artifacts: {
    search: string
    refresh: string
    refreshing: string
    indexing: string
    tabAll: string
    tabImages: string
    tabFiles: string
    tabLinks: string
    noArtifactsTitle: string
    noArtifactsDesc: string
    failedLoad: string
    openFailed: string
    itemsImage: string
    itemsLink: string
    itemsFile: string
    itemsGeneric: string
    zero: string
    rangeOf: (start: number, end: number, total: number) => string
    goToPage: (itemLabel: string, page: number) => string
    colTitleLink: string
    colTitleFile: string
    colTitleDefault: string
    colLocationLink: string
    colLocationFile: string
    colLocationDefault: string
    colSession: string
    kindImage: string
    kindFile: string
    kindLink: string
    chat: string
    copyUrl: string
    copyPath: string
  }

  sidebar: {
    navAria?: string
    emptyRoster?: string
    nav: Record<string, string>
    searchAria: string
    searchPlaceholder: string
    clearSearch: string
    noMatch: (query: string) => string
    results: string
    pinned: string
    sessions: string
    cronJobs: string
    groupAriaGrouped: string
    groupAriaUngrouped: string
    showProjects: string
    showSessions: string
    groupTitleGrouped: string
    groupTitleUngrouped: string
    allPinned: string
    shiftClickHint: string
    noWorkspace: string
    noProject: string
    projectEmpty: string
    noSessions: string
    projects: {
      sectionLabel: string
      newButton: string
      createTitle: string
      createDesc: string
      renameTitle: string
      addFolderTitle: string
      namePlaceholder: string
      foldersLabel: string
      ideaLabel: string
      ideaPlaceholder: string
      ideaGenerate: string
      ideaGenerating: string
      ideaShuffle: string
      noFolders: string
      addFolder: string
      primaryBadge: string
      removeFolder: string
      create: string
      menu: string
      menuRename: string
      menuAppearance: string
      noColor: string
      menuAddFolder: string
      menuSetActive: string
      menuDelete: string
      reveal: string
      copyPath: string
      removeFromSidebar: string
      createFailed: string
      staleBackend: string
      deleteConfirm: string
      startWork: string
      newWorktreeTitle: string
      newWorktreeDesc: string
      branchPlaceholder: string
      branchOff: () => { after: string; before: string }
      baseBranchPlaceholder: string
      baseBranchNone: string
      startWorkFailed: string
      convertBranch: string
      convertBranchTitle: string
      convertBranchDesc: string
      convertBranchPlaceholder: string
      convertBranchInstead: string
      branchOpenExisting: string
      branchSwitchHome: string
      branchCreateWorktree: string
      branchesLoading: string
      noBranches: string
      removeWorktree: string
      removeWorktreeFailed: string
      removeWorktreeConfirm: string
      removeWorktreeDirty: string
      forceRemove: string
      enter: (label: string) => string
      reorder: (label: string) => string
      toggle: (label: string) => string
      back: string
    }
    newSessionIn: (label: string) => string
    showMoreIn: (count: number, label: string) => string
    loading: string
    loadMore: string
    loadCount: (step: number) => string
    row: {
      sessionIdle?: string
      pin: string
      unpin: string
      copyId: string
      export: string
      branchFrom: string
      rename: string
      archive: string
      newWindow: string
      hideTabBar: string
      openInNewTab: string
      openInSplit: string
      copyIdFailed: string
      actionsFor: (title: string) => string
      sessionActions: string
      sessionRunning: string
      needsInput: string
      waitingForAnswer: string
      finishedUnread: string
      backgroundRunning: string
      handoffOrigin: (platform: string) => string
      ownedByProfile: (profile: string) => string
      renamed: string
      renameFailed: string
      renameTitle: string
      renameDesc: string
      untitledPlaceholder: string
      untitledChat: (id: string) => string
      ageNow: string
      ageDay: string
      ageHour: string
      ageMin: string
    }
  }

  composer: {
    bringWordToFront: string
    workWith: string
    chooseDocumentOrApp: string
    inThisConversation: string
    openWindows: string
    otherApps: string
    linkAndShowBeside: string
    linkAndShow: string
    linkOnly: string
    linked: string
    automatic: string
    readWhenYouSend: string
    savedFile: string
    liveWordText: string
    unavailable: string
    reconnect: string
    changeContext: string
    showBeside: string
    useAutomaticContext: string
    removeContext: string
    contextPaused: string
    contextPausedDetail: string
    sendWithoutDocument: string
    allowDocumentAccess: string
    openSettings: string
    chooseFile: string
    noDocumentChoices: string
    linkedCouldNotShowBeside: string
    contextQueueUnavailable: string
    contextNotIncluded: string
    contextUnavailable: string
    contextLoading: string
    contextSelectionChanged: string
    contextOwnerChanged: string
    contextCapacity: string
    capturedUnsaved: string
    capturedImage: string
    capturedFile: string
    capturedSaved: string
    capturedTruncated: string
    contextMissing: string
    contextUncertain: string
    contextUpdate: string
    contextWithout: string
    recoveredDrafts: string
    restoreDraft: string
    fileContext: string
    fileContextHint: string
    openExternal: string
    fileOpenFailed: string
    workingWithDocument: (name: string) => string
    documentSelectedLines: (count: number) => string
    documentTruncated: string
    documentChanged: string
    documentOutsideWorkspace: string
    documentRefused: string
    suppressDocumentContext: string
    addContext: string
    message: string
    wakingProfile: (profile: string) => string
    placeholderStarting: string
    placeholderReconnecting: string
    placeholderFollowUp: string
    newSessionPlaceholders: readonly string[]
    followUpPlaceholders: readonly string[]
    startVoice: string
    queueMessage: string
    steer: string
    stop: string
    send: string
    speaking: string
    transcribing: string
    thinking: string
    muted: string
    listening: string
    muteMic: string
    unmuteMic: string
    stopListening: string
    stopShort: string
    endConversation: string
    endShort: string
    stopDictation: string
    transcribingDictation: string
    voiceDictation: string
    speakReplies: string
    stopSpeakingReplies: string
    lookupLoading: string
    lookupNoMatches: string
    lookupTry: string
    lookupOr: string
    commonCommands: string
    hotkeys: string
    helpFooter: string
    commandDescs: Record<string, string>
    hotkeyDescs: Record<string, string>
    attachUrlTitle: string
    attachUrlDesc: string
    urlPlaceholder: string
    urlHintPre: string
    attach: string
    queued: (count: number) => string
    queuedPaused: (count: number) => string
    attachmentOnly: string
    emptyTurn: string
    attachments: (count: number) => string
    editingInComposer: string
    editingQueuedInComposer: string
    queueEdit: string
    queueSendNext: string
    queueSend: string
    queueDelete: string
    queueResume: string
    queueResumeTip: string
    queueStuckTitle: string
    queueStuckBody: string
    previewUnavailable: string
    previewLabel: (label: string) => string
    couldNotPreview: (label: string) => string
    removeAttachment: (label: string) => string
    dictating: string
    preparingAudio: string
    speakingResponse: string
    readingAloud: string
    themeSuggestions: string
    noMatchingThemes: string
    themeTryPre: string
    themeTryPost: string
    attachLabel: string
    files: string
    folder: string
    images: string
    pasteImage: string
    url: string
    promptSnippets: string
    tipPre: string
    tipPost: string
    snippetsTitle: string
    snippetsDesc: string
    snippets: Record<string, { label: string; description: string; text: string }>
    dropFiles: string
    dropSession: string
  }

  statusStack: {
    agents: string
    background: (count: number) => string
    subagents: (count: number) => string
    todos: (done: number, total: number) => string
    running: string
    stop: string
    dismiss: string
    exit: (code: number) => string
    assistantText: {
      saved: (name: string) => string
      savedDetail: string
      open: string
      continue: string
      retry: string
      details: string
      failureCode: (code: string) => string
      incident: (reference: string) => string
      failures: {
        permission_required: string
        permission_denied: string
        permission_expired: string
        account_stale: string
        scope_escape: string
        conflict: string
        too_large: string
        io_failed: string
      }
    }
    interaction: {
      permissionNeeded: string
      capability: string
      scope: string
      effect: string
      duration: string
      seconds: (count: number) => string
      later: string
      deny: string
      allowOnce: string
      ready: string
      active: string
      revoke: string
      revoked: string
      finished: string
      partialEffects: string
      stoppedSafely: string
      actionFailed: string
    }
    coding: {
      title: string
      noBranch: string
      detached: string
      clean: string
      changed: (count: number) => string
      ahead: (count: number) => string
      behind: (count: number) => string
      review: string
      close: string
      openChanges: string
      openFile: string
      stage: string
      unstage: string
      stageAll: string
      viewAsTree: string
      viewAsList: string
      revert: string
      revertAll: string
      revertConfirm: string
      revertAllConfirm: string
      staged: string
      noChanges: string
      notRepo: string
      noDiff: string
      scopeUncommitted: string
      scopeBranch: string
      scopeLastTurn: string
      commit: string
      commitAndPush: string
      commitPlaceholder: string
      generateCommitMessage: string
      stopGenerating: string
      createPr: string
      openPr: string
      ghMissing: string
      agentShip: string
      agentShipPrompt: string
      newBranch: string
      branchOffFrom: (base: string) => string
      switchTo: (branch: string) => string
      switchFailed: (branch: string) => string
      worktrees: string
    }
  }

  updates: {
    stages: Record<string, string>
    checking: string
    checkFailedTitle: string
    tryAgain: string
    notAvailableTitle: string
    unsupportedMessage: string
    connectionRetry: string
    latestBody: string
    latestBodyBackend: string
    allSetTitle: string
    availableTitle: string
    availableBody: string
    availableTitleBackend: string
    availableBodyBackend: string
    availableBodyNoChangelog: string
    updateNow: string
    maybeLater: string
    moreChanges: (count: number) => string
    manualTitle: string
    manualBody: string
    manualPickedUp: string
    /** GUI/backend skew (#45205): backend updated but the running desktop app
     *  package (AppImage/.deb/.rpm) was not changed and must be reinstalled. */
    guiSkewTitle: string
    guiSkewBody: string
    copy: string
    copied: string
    done: string
    applyingBody: string
    applyingBodyBackend: string
    applyingClose: string
    errorTitle: string
    errorBody: string
    notNow: string
    applyStatus: {
      preparing: string
      pulling: string
      restarting: string
      notAvailable: string
      failed: string
      noReturn: string
    }
  }

  install: {
    stageStates: Record<string, string>
    oneTimeTitle: string
    unsupportedDesc: (platform: string) => string
    installCommand: string
    copyCommand: string
    viewDocs: string
    installTo: string
    retryAfterRun: string
    failedTitle: string
    settingUpTitle: string
    finishingTitle: string
    failedDesc: string
    activeDesc: string
    progress: (completed: number, total: number) => string
    currentStage: (stage: string) => string
    fetchingManifest: string
    error: string
    hideOutput: string
    showOutput: string
    lines: (count: number) => string
    noOutput: string
    cancelling: string
    cancelInstall: string
    transcriptSaved: string
    copiedOutput: string
    copyOutput: string
    reloadRetry: string
  }

  onboarding: {
    headerTitle: string
    headerSub?: string
    headerDesc: string
    preparingInstall: string
    starting: string
    lookingUpProviders: string
    collapse: string
    otherProviders: string
    haveApiKey: string
    chooseLater: string
    recommended: string
    connected: string
    featuredPitch: string
    fireworksPitch: string
    openRouterPitch: string
    apiKeyOptions: Record<string, { short: string; description: string }>
    backToSignIn: string
    getKey: string
    replaceCurrent: string
    pasteApiKey: string
    localApiKeyPlaceholder: string
    couldNotSave: string
    connecting: string
    update: string
    flowSubtitles: Record<string, string>
    startingSignIn: (provider: string) => string
    verifyingCode: (provider: string) => string
    connectedProvider: (provider: string) => string
    connectedPicking: (provider: string) => string
    signInFailed: string
    pickDifferentProvider: string
    signInWith: (provider: string) => string
    openedBrowser: (provider: string) => string
    authorizeThere: string
    copyAuthCode: string
    pasteAuthCode: string
    reopenAuthPage: string
    autoBrowser: (provider: string) => string
    reopenSignInPage: string
    waitingAuthorize: string
    externalPending: (provider: string) => string
    signedIn: string
    deviceCodeOpened: (provider: string) => string
    reopenVerification: string
    copy: string
    defaultModel: string
    freeTier: string
    pro: string
    free: string
    price: (input: string, output: string) => string
    change: string
    startChatting: string
    docs: (provider: string) => string
  }

  modelPicker: {
    title: string
    current: string
    unknown: string
    search: string
    noModels: string
    addProvider: string
    loadFailed: string
    noAuthenticatedProviders: string
    pro: string
    proNeedsSubscription: string
    free: string
    freeTier: string
    priceTitle: string
    wasPrice: string
  }

  modelVisibility: {
    title: string
    search: string
    noAuthenticatedProviders: string
    addProvider: string
  }

  shell: {
    windowControls: string
    paneControls: string
    appControls: string
    modelMenu: {
      search: string
      noModels: string
      editModels: string
      refreshModels: string
      fast: string
      medium: string
      unsupported: string
    }
    modelOptions: {
      noOptions: string
      options: string
      thinking: string
      fast: string
      effort: string
      minimal: string
      low: string
      medium: string
      high: string
      xhigh: string
      max: string
      ultra: string
      updateFailed: string
      fastFailed: string
    }
    gatewayMenu: {
      gateway: string
      connected: string
      connecting: string
      offline: string
      inferenceReady: string
      inferenceNotReady: string
      checkingInference: string
      disconnected: string
      openSystem: string
      connection: (label: string) => string
      recentActivity: string
      viewAllLogs: string
      messagingPlatforms: string
    }
    approvalMode: {
      title: string
      ariaLabel: (mode: string) => string
      manual: string
      manualDescription: string
      smart: string
      smartDescription: string
      off: string
      offDescription: string
    }
    statusbar: {
      unknown: string
      restart: string
      update: string
      updateInProgress: string
      commitsBehind: (count: number, branch: string) => string
      desktopVersion: (version: string) => string
      backendVersion: (version: string) => string
      clientLabel: (version: string) => string
      connectionSsh: (host: string) => string
      connectionRemote: (host: string) => string
      connectionCloud: (host: string) => string
      connectionCloudTooltip: (host: string) => string
      connectionSshTooltip: (host: string) => string
      connectionRemoteTooltip: (host: string) => string
      backendLabel: (version: string) => string
      commit: (sha: string) => string
      branch: (branch: string) => string
      closeCommandCenter: string
      openCommandCenter: string
      showTerminal: string
      hideTerminal: string
      gateway: string
      gatewayReady: string
      gatewayNeedsSetup: string
      gatewayChecking: string
      gatewayConnecting: string
      gatewayOffline: string
      gatewayRestarting: string
      gatewayTitle: string
      agents: string
      closeAgents: string
      openAgents: string
      subagents: (count: number) => string
      failed: (count: number) => string
      running: (count: number) => string
      cron: string
      openCron: string
      starmap: string
      openStarmap: string
      turnRunning: string
      currentTurnElapsed: string
      contextUsage: string
      contextUsagePanel: {
        categories: {
          conversation: string
          mcp: string
          memory: string
          rules: string
          skills: string
          subagent_definitions: string
          system_prompt: string
          tool_definitions: string
        }
        empty: string
        loading: string
        percentFull: (percent: number) => string
        title: string
        tokenSummary: (used: string, max: string) => string
      }
      openContextUsage: string
      session: string
      runtimeSessionElapsed: string
      yoloOn: string
      yoloOff: string
      modelNone: string
      noModel: string
      switchModel: string
      openModelPicker: string
      modelPinned: string
      modelTitle: (provider: string, model: string) => string
      providerModelTitle: (provider: string, model: string) => string
    }
  }

  rightSidebar: {
    aria: string
    panelsAria: string
    files: string
    terminal: string
    noFolderSelected: string
    changeCwdTitle: string
    remotePickerTitle: string
    remotePickerDescription: string
    remotePickerSelect: string
    folderTip: (cwd: string) => string
    openFolder: string
    refreshTree: string
    collapseAll: string
    previewUnavailable: string
    couldNotPreview: (path: string) => string
    noProjectTitle: string
    noProjectBody: string
    noProjectOpen: string
    noDiffs: string
    unreadableTitle: string
    unreadableBody: (error: string) => string
    emptyTitle: string
    emptyBody: string
    treeErrorTitle: string
    treeErrorBody: string
    tryAgain: string
    loadingTree: string
    loadingFiles: string
    terminalHide: string
    terminalsAria: string
    terminalNew: string
    terminalCloseOthers: string
    terminalCloseAll: string
    addToChat: string
  }

  document: {
    linkAddress: string
    applyLink: string
    richEditor: string
    richUnavailable: string
    richPasteRefused: string
    richPastePlain: string
    richPasteSimplified: string
    richEditRefused: string
    rowAfter: string
    columnAfter: string
    deleteRow: string
    deleteColumn: string
    readOnlyLarge: string
    saveBeforeSignOut: string
    toolbar: string
    write: string
    insert: string
    page: string
    view: string
    more: string
    style: string
    normal: string
    heading: string
    undo: string
    redo: string
    zoom: string
    fitWidth: string
    outline: string
    findReplace: string
    find: string
    replace: string
    next: string
    previousMatch: string
    noMatches: string
    matchCount: string
    replaceSelection: string
    saved: string
    saveFailed: string
    recoveryUnavailable: string
    recoveryAvailable: string
    recover: string
    discardRecovery: string
    recoveryConflict: string
    discardLocalChangesAndReload: string
    discardLocalChangesAndClose: string
    discardLocalChangesConfirm: string
    offlineEdits: string
    keepEdits: string
    menu: string
    sourceAdvanced: string
    words: (count: number) => string
  }

  preview: {
    tab: string
    closeTab: (label: string) => string
    closeOthers: string
    closeToRight: string
    closeAll: string
    closePane: string
    loading: string
    unavailable: string
    /** Empty-state label shown by the rail pane before any file is opened. */
    emptyTitle: string
    emptyHint: string
    opening: string
    hide: string
    openPreview: string
    openInBrowser: string
    linkHint: string
    sourceLineTitle: string
    source: string
    renderedPreview: string
    diff: string
    unknownSize: string
    binaryTitle: string
    binaryBody: (label: string) => string
    /** Owner ruling: files the panel cannot render launch in the OS app. */
    openNative: string
    largeTitle: string
    largeBody: (label: string, size: string) => string
    previewAnyway: string
    truncated: string
    noInlineTitle: string
    noInlineBody: (mimeType: string) => string
    edit: string
    editing: string
    unsavedChanges: string
    saveFailed: (message: string) => string
    diskChangedTitle: string
    diskChangedBody: string
    overwrite: string
    discardReload: string
    workspaceLeaseStaleTitle: string
    workspaceLeaseStaleBody: string
    reopenTextFile: string
    agentReviewEdited: string
    agentReviewView: string
    agentReviewDone: string
    agentReviewUndo: string
    agentReviewSaveDraft: string
    agentReviewDiscardUndo: string
    agentReviewLater: string
    agentReviewRetry: string
    agentReviewUndoDirty: string
    agentReviewUndoUnsettled: string
    agentReviewPending: string
    agentReviewUndoChanged: string
    agentReviewDisconnected: string
    agentReviewRestoreFailed: string
    agentReviewFailed: (message: string) => string
    documentModeRead: string
    documentModeLive: string
    documentModeSource: string
    documentModeDiff: string
    toolbarLabel: string
    toolbarHeading: string
    toolbarStrong: string
    toolbarEmphasis: string
    toolbarList: string
    toolbarLink: string
    toolbarStrikethrough: string
    toolbarCode: string
    toolbarOrderedList: string
    toolbarQuote: string
    toolbarCodeBlock: string
    toolbarTable: string
    toolbarTableColumn: string
    documentTooLargeForLive: string
    liveEditorDescription: string
    exportMenu: string
    exportWord: string
    exportPdf: string
    themeMenu: string
    themeNameManuscript: string
    themeNameModern: string
    themeNameReport: string
    themeNameBook: string
    themeNameNote: string
    themePageSize: string
    themePageA4: string
    themePageLetter: string
    themeBodySize: string
    themeBodyDefault: string
    themeBodyLarge: string
    themeBodyLarger: string
    themeReset: string
    themeSaveFailed: string
    exportShare: string
    exportChoiceBody: string
    exportSaveThen: string
    exportSaved: string
    exportLater: string
    exportInProgress: string
    exportDone: (name: string) => string
    exportReveal: string
    exportFailed: (reason: string) => string
    exportRetry: string
    exportDismiss: string
    exportReasonTooLarge: string
    exportReasonChanged: string
    exportReasonNotWorkspace: string
    exportReasonGeneric: string
    closeDirtyTitle: string
    closeDirtyBody: string
    workspaceDiskChangedBody: string
    preserveDraft: string
    closeWithoutSaving: string
    keepEditing: string
    preservedDraft: (displayName: string) => string
    docx: {
      empty: string
      failed: (message: string) => string
      refreshing: string
      truncatedBody: string
      truncatedTitle: string
    }
    console: {
      deselect: string
      select: string
      copyFailed: string
      copyEntry: string
      sendEntry: string
      messages: (count: number) => string
      resize: string
      title: string
      selected: (count: number) => string
      sendToChat: string
      copySelected: string
      copyAll: string
      copy: string
      clear: string
      empty: string
      promptHeader: string
      sentTitle: string
      sentMessage: (count: number) => string
    }
    web: {
      appFailedToBoot: string
      serverNotFound: string
      failedToLoad: string
      tryAgain: string
      restarting: string
      askRestart: string
      lookingRestart: (taskId: string) => string
      restartingTitle: string
      restartingMessage: string
      startRestartFailed: (message: string) => string
      restartFailed: string
      hideConsole: string
      showConsole: string
      finishedRestarting: (message?: string) => string
      failedRestarting: (message: string) => string
      unknownError: string
      restartedTitle: string
      reloadingNow: string
      restartFailedTitle: string
      restartFailedMessage: string
      stillWorking: string
      workspaceReloading: string
      fileChanged: (url: string) => string
      filesChanged: (count: number, url: string) => string
      watchFailed: (message: string) => string
      moduleMimeDescription: string
      loadFailedConsole: (code: number | undefined, message: string) => string
      unreachableDescription: string
      openTarget: (url: string) => string
      fallbackTitle: string
    }
  }

  zones: {
    showHeader: string
    hideHeader: string
    minimize: string
    restore: string
    closeRunningTitle: string
    closeRunningBody: string
    closeRunningConfirm: string
    closeOthers: string
    closeToRight: string
    closeAll: string
    newSessionTab: string
    split: (dir: string) => string
    move: (dir: string) => string
    dirUp: string
    dirDown: string
    dirLeft: string
    dirRight: string
    pluginDisabled: (pluginId: string) => string
    pluginDisabledBody: string
    missingPane: (paneId: string) => string
    editTitle: string
    editHint: string
    reset: string
    templates: string
    custom: string
    newGridLayout: string
    saveCurrentAs: string
    nameLayoutPlaceholder: string
    deletePreset: (name: string) => string
    zoneEditorTitle: string
    editorHintPre: string
    editorHintPost: string
    templateColumns: string
    templateRows: string
    templateGrid: string
    templatePriority: string
    zoneTag: (index: number) => string
    mergeZones: (count: number) => string
    customZoneName: (count: number) => string
    layoutNamePlaceholder: (fallback: string) => string
    saveApply: string
    notExpressible: string
    zoneCount: (count: number) => string
  }

  assistant: {
    retry?: string
    copy?: string
    thread: {
      loadingSession: string
      showEarlier: string
      loadingResponse: string
      compacting: string
      resumeWhenBackgroundDone: (count: number) => string
      thinking: string
      today: (time: string) => string
      yesterday: (time: string) => string
      copy: string
      refresh: string
      moreActions: string
      branchNewChat: string
      dismissError: string
      readAloudFailed: string
      preparingAudio: string
      stopReading: string
      readAloud: string
      editMessage: string
      expandMessage: string
      scrollToBottom: string
      stop: string
      restorePrevious: string
      restoreCheckpoint: string
      restoreFromHere: string
      restoreTitle: string
      restoreBody: string
      restoreConfirm: string
      restoreNext: string
      goForward: string
      sendEdited: string
      attachingFile: string
    }
    approval: {
      gatewayDisconnected: string
      sendFailed: string
      run: string
      command: string
      moreOptions: string
      allowSession: string
      jumpToApproval: string
      reject: string
      alwaysAllow: string
    }
    clarify: {
      notReady: string
      gatewayDisconnected: string
      sendFailed: string
      loadingQuestion: string
      other: string
      placeholder: string
      skip: string
      skipped: string
      continueLabel: string
      lateAnswer: (question: string, choice: string) => string
      lateAnswerTip: string
      lateAnswerHint: string
    }
    tool: {
      approvalTitle?: string
      approveOnce?: string
      approveSession?: string
      approveAlways?: string
      deny?: string
      code: string
      copyCode: string
      renderingImage: string
      copyOutput: string
      copyCommand: string
      copyContent: string
      copyUrl: string
      copyResults: string
      copyQuery: string
      copyFile: string
      copyPath: string
      outputAlt: string
      rawResponse: string
      copyActivity: string
      recoveredOne: string
      recoveredMany: (count: number) => string
      failedOne: string
      failedMany: (count: number) => string
      statusRunning: string
      statusError: string
      statusRecovered: string
      statusDone: string
      consumerWeb: {
        cancelled: string
        permissionRequired: string
        permissionRequiredDetail: string
        permissionRevoked: string
        permissionRevokedDetail: string
        slow: string
      }
      consumerInteraction: {
        cancelled: string
        permissionRequired: string
        permissionRequiredDetail: string
        permissionRevoked: string
        permissionRevokedDetail: string
      }
      actions: {
        read: string
        reading: string
        opened: string
        opening: string
        failedToOpen: string
        searched: string
        searching: string
        ran: string
        running: string
        ranCode: string
        runningCode: string
      }
      prefixes: {
        browser: string
        web: string
      }
      titleTemplates: {
        actionCommand: (action: string, command: string) => string
        actionQuoted: (action: string, value: string) => string
        actionTarget: (action: string, target: string) => string
        prefixedDone: (prefix: string, action: string) => string
        runningPrefixedTool: (prefix: string, action: string) => string
        runningTool: (action: string) => string
      }
      titles: Record<ToolTitleKey, ToolTitleCopy>
    }
  }

  prompts: {
    gatewayDisconnected: string
    sudoSendFailed: string
    secretSendFailed: string
    sudoTitle: string
    sudoDesc: string
    sudoPlaceholder: string
    secretTitle: string
    secretDesc: string
    secretPlaceholder: string
  }

  desktop: {
    audioReadFailed: string
    sessionUnavailable: string
    createSessionFailed: string
    promptFailed: string
    providerCredentialRequired: string
    emptySlashCommand: string
    desktopCommands: string
    skillCommandsAvailable: (count: number) => string
    warningLine: (message: string) => string
    yoloArmed: string
    yoloOff: string
    yoloSystem: (active: boolean) => string
    yoloTitle: string
    yoloToggleFailed: string
    profileStatus: (current: string) => string
    unknownProfile: string
    noProfileNamed: (target: string, available: string) => string
    newChatsProfile: (name: string) => string
    setProfileFailed: string
    sttDisabled: string
    stopFailed: string
    regenerateFailed: string
    editFailed: string
    resumeFailed: string
    resumeStrandedTitle: string
    resumeStrandedBody: string
    resumeRetry: string
    nothingToBranch: string
    branchNeedsChat: string
    sessionBusy: string
    branchStopCurrent: string
    branchNoText: string
    branchTitle: (n: number) => string
    branchFailed: string
    deleteFailed: string
    archived: string
    archiveFailed: string
    cwdChangeFailed: string
    cwdStagedTitle: string
    cwdStagedMessage: string
    modelSwitchFailed: string
    sessionExported: string
    sessionExportFailed: string
    imageSaved: string
    downloadStarted: string
    restartToUseSaveImage: string
    restartToSaveImages: string
    imageDownloadFailed: string
    openImage: string
    downloadImage: string
    savingImage: string
    imagePreviewFailed: string
    imageAttach: string
    imageWriteFailed: string
    imageAttachFailed: string
    attachImages: string
    clipboard: string
    noClipboardImage: string
    clipboardPasteFailed: string
    dropFiles: string
    handoff: {
      pickPlatform: string
      success: (platform: string) => string
      systemNote: (platform: string) => string
      failed: (error: string) => string
      timedOut: string
    }
  }

  errors: {
    offline?: string
    turnFailed?: string
    genericFailure: string
    boundaryTitle: string
    boundaryDesc: string
    reloadWindow: string
    openLogs: string
  }

  ui: {
    search: {
      clear: string
    }
    pagination: {
      label: string
      previous: string
      previousAria: string
      next: string
      nextAria: string
    }
    sidebar: {
      title: string
      description: string
      toggle: string
    }
  }

  /** Shared Atum presentation used by the isolated Matrix desktop candidate. */
  models: {
    effort: string
    efforts: Record<'low' | 'medium' | 'high' | 'max', string>
    effortHelp: Record<'low' | 'medium' | 'high' | 'max', string>
    effortProtons: string
    modelDefault: string
    /** The thinking control's reset, naming the level it goes back to. */
    effortReset: (level: string) => string
    /** The control's name for a model's own default, when no advertised level applies. */
    effortDefaultLabel: string
  }

  surfaces: {
    comingSoon: string
    comingSoonHelp: string
    needsSetup: string
    needsUpdate: string
    needsUpdateHelp: string
  }

  matrixShell: {
    assistantSetup: string
    assistantSetupHelp: string
    assistantOptions: string
    messageActions: string
    messagePosition: (position: number) => string
    pinFailed: string
    languageLoadFailed: string
    assistantName: string
    mainAgent: string
    /** First launch: one button when automatic setup needs a click or failed. */
    assistantSetupAction: string
    assistantSetupWorking: string
    assistantSetupFailed: string
    /** Cold-start screen: the step being prepared, the one click, a failure. */
    startupSignedIn: string
    startupAssistant: string
    startupModel: string
    startupConnectTitle: string
    startupConnectAction: string
    startupAssistantFailed: string
    startupModelFailed: string
    startupFailedHelp: string
    /** Loading screen: the readiness gate's current step (plan 2026-09-26-reliable-local-first-chat §4.5). */
    startupHermes: string
    startupAi: string
    startupAuthority: string
    /** The launch screen's stream: a step still running after 5 s, after 30 s, and the bar's name. */
    launchStill: string
    launchLong: string
    launchProgress: string
    /** The stream's finished lines, one per launch check, in order. */
    launchDoneSignedIn: string
    launchDoneAssistant: string
    launchDoneWorkspace: string
    launchDoneAi: string
    launchDoneAccount: string
    /** The first launch's story (the approved welcome motion): its spoken line, the line under it, Skip. */
    welcomeLine: string
    welcomeSub: string
    welcomeSkip: string
    /** An assistant's empty chat: the time of day's greeting and the approved prompt line. */
    greetMorning: string
    greetAfternoon: string
    greetEvening: string
    greetPrompt: string
    /** Discover in the Matrix window: its line, and an honest empty shelf. */
    discoverSubtitle: string
    discoverShelfEmpty: string
    /** A line of Protons activity that did not complete. */
    protonsRefunded: string
    protonsCancelled: string
    protonsActivity: string
    /** Blocked gate and degraded banner: plain reasons keyed by the readiness code. */
    readinessOffline: string
    readinessAiUnavailable: string
    readinessOutOfProtons: string
    readinessSignIn: string
    readinessPlatform: string
    readinessAssistant: string
    readinessChat: string
    readinessRuntime: string
    readinessAuthorityWithdrawn: string
    readinessAuthorityWithdrawnHelp: string
    readinessOutOfProtonsHelp: string
    readinessSetupWaiting: string
    readinessSetupWaitingHelp: string
    readinessSetupWaitingUntil: string
    protonsAbout: string
    protonsOwnModel: string
    /** Added under a gate blocked for two minutes. */
    readinessHelp: string
    /** Degraded: the composer is paused, drafts are kept. */
    readinessPaused: string
    /** Local turn states and notices (§4.6); never the runtime's name. */
    turnNotSent: string
    turnInterrupted: string
    turnRetry: string
    /** A handed-off question (0.19.4 Q4: never where it is answered). `turnHomeQuiet`: no answer
     * in its bounded time, with `turnAnswerHere`/`turnAlwaysAnswerHere` to answer right away. */
    turnHomeQuiet: string
    turnAnswerHere: string
    turnAlwaysAnswerHere: string
    turnAnswerHereFailed: string
    /** The conversation's model picker: the default model (never named until Atum serves its own),
     * its line, a legacy pick's line, and the way to the agent's Model & Memory settings. */
    modelPicker: string
    /** The line-up's one-line descriptors: Nguyệt Thực, Nhật Thực and Thái Cực. */
    modelHard: string
    modelFlagship: string
    modelDefaultName: string
    modelRecommended: string
    modelDefault: string
    modelAdvanced: string
    modelAdvancedHelp: string
    /** The agent's daily cap (item 23): the row, its value, the editor and the server's two
     * non-normal states. The state lines are usage facts; they never claim turns stop. */
    dailyCap: string
    dailyCapProtons(amount: string): string
    dailyCapUnlimited: string
    dailyCapAmount: string
    dailyCapHelp: string
    dailyCapWarning: string
    dailyCapExhausted: string
    dailyCapInvalid: string
    dailyCapSaveFailed: string
    assistantHistoryOnly: string
    newAssistantChat: string
    /** The person's other agents ( §2.8). */
    newAgent: string
    agentImport: string
    agentImportHelp: string
    agentCreate: string
    agentCreating: string
    agentCreateFailed: string
    /** The platform refused for good: the name, the limit, or the account. */
    agentNameRefused: string
    agentLimitRefused: string
    agentAccountRefused: string
    agentHireTitle: string
    agentHireLine: string
    agentHireConfirm: string
    agentHireLater: string
    agentHireShort: string
    agentPaused: string
    agentRenew: string
    agentSettingUp: string
    agentUnavailable: string
    /** What an assistant's avatar dot means, read with its row (the dot itself is decoration). */
    agentDotReady: string
    agentDotNeedsYou: string
    agentDotOffline: string
    agentDotUnreachable: string
    agentRetireAction: (name: string) => string
    agentRetireTitle: (name: string) => string
    agentRetireBody: (name: string) => string
    agentRetireConfirm: string
    agentRetireFailed: string
    agentCancel: string
    navigation: string
    home: string
    discover: string
    discoverUnavailable: string
    /** The rail's Team space (its Workplace place) while it is not open yet. */
    workplace: string
    drive: string
    /** The rail's account control, its menu and the Settings sheet (design lane D1). */
    account: string
    accountDisconnected: string
    settings: string
    settingsGeneral: string
    settingsPrivacy: string
    settingsAssistant: string
    settingsLanguage: string
    settingsDevice: string
    toolRunning: string
    toolComplete: string
  }

  ws3: {
    hostedDm: { title: string; body: string }
  }
}
