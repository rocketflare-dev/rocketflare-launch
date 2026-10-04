/**
 * Why a turn could not lease its credential (§18.22). Each message is a sentence safe to store in a
 * `turn.failed` event and show the person — never the credential, never the provider's body.
 */

/** The personal account is disconnected, refused by the provider, or past its expiry. */
export class CredentialNeedsLoginError extends Error {
  constructor(accountLabel: string) {
    super(`Reconnect your ${accountLabel} on the Home page, then send your message again.`)
    this.name = 'CredentialNeedsLoginError'
  }
}

/** Another session holds the credential right now (one ChatGPT `auth.json`, one turn at a time). */
export class CredentialBusyError extends Error {
  constructor(accountLabel: string) {
    super(
      `Your ${accountLabel} is in use by another session. Wait for its turn to finish, then send your message again.`
    )
    this.name = 'CredentialBusyError'
  }
}

/** The session bills a personal account but these ports cannot lease one. */
export class CredentialPortMissingError extends Error {
  constructor() {
    super('This session bills a personal account, which Launch could not reach for this turn.')
    this.name = 'CredentialPortMissingError'
  }
}
