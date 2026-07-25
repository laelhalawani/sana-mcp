export class AuthenticationOriginMismatchError extends Error {}
export class LegacyPartialSessionError extends Error {}
export class NoPendingLoginError extends Error {}
export class SanaInputValidationError extends Error {}
export class SignInChallengeRejectedError extends Error {}
export class SanaHttpError extends Error {
  constructor(readonly status: number) {
    super(`synthetic Sana HTTP ${status}`);
  }
}

export class SanaClient {
  static load(): SanaClient {
    return new SanaClient();
  }

  hasAuthCookie(): boolean {
    return true;
  }

  sessionVersion(): Readonly<{
    generation: 1;
    publicationToken: string;
    userId: string;
    workspaceId: string;
  }> {
    return {
      generation: 1,
      publicationToken: [
        "22222222",
        "2222",
        "4222",
        "8222",
        "222222222222",
      ].join("-"),
      userId: "user-contract",
      workspaceId: "workspace-contract",
    };
  }
}
