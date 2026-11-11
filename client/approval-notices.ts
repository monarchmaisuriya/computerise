// Paseo cannot mark an agent as needing input for a plugin, so an approval card in a chat the user
// is not looking at waits unseen until it times out. Each new request also shows a desktop
// notification.

export type PendingApproval = { requestId: string; agentId: string; action: string };
export type Notify = (title: string, body: string) => void;

export class ApprovalNotices {
  private readonly shown = new Set<string>();

  constructor(private readonly notify: Notify) {}

  update(pending: readonly PendingApproval[], titleOf: (agentId: string) => string): void {
    const waiting = new Set(pending.map((approval) => approval.requestId));
    for (const requestId of [...this.shown]) if (!waiting.has(requestId)) this.shown.delete(requestId);
    for (const approval of pending) {
      if (this.shown.has(approval.requestId)) continue;
      this.shown.add(approval.requestId);
      this.notify("Computer action waiting", `${titleOf(approval.agentId)}: ${approval.action}`);
    }
  }
}

type Permission = "default" | "granted" | "denied";
// The slice of the web Notification API used here; client code compiles without DOM types.
type NotificationApi = { readonly permission: Permission; requestPermission(): Promise<Permission>; new (title: string, options: { body: string }): unknown };

// Without notifications the card and the Computer panel still work, so a missing or refused
// permission is reported once rather than on every request.
export function desktopNotifier(log: (message: string) => void = console.error): Notify {
  let reported = false;
  const report = (reason: string) => {
    if (reported) return;
    reported = true;
    log(`Computerise cannot show desktop notifications: ${reason}`);
  };
  const show = (api: NotificationApi, title: string, body: string) => {
    try {
      new api(title, { body });
    } catch (error) {
      report(String(error));
    }
  };
  return (title, body) => {
    const api = (globalThis as { Notification?: NotificationApi }).Notification;
    if (!api) return report("this Paseo app has no notifications");
    if (api.permission === "granted") return show(api, title, body);
    if (api.permission === "denied") return report("notifications are turned off for Paseo");
    void api.requestPermission().then(
      (answer) => (answer === "granted" ? show(api, title, body) : report("notifications are turned off for Paseo")),
      (error: unknown) => report(String(error)),
    );
  };
}
