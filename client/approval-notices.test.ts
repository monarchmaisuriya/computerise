import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalNotices, desktopNotifier } from "./approval-notices";

const open = (requestId: string, agentId = "agent-1") => ({ requestId, agentId, action: "open Slack (com.tinyspeck.slackmacgap)" });
const titleOf = (agentId: string) => (agentId === "agent-1" ? "Slack thread check" : agentId);

describe("approval notices", () => {
  it("notifies once for each new request, naming the chat and the action", () => {
    const notify = vi.fn();
    const notices = new ApprovalNotices(notify);
    notices.update([open("r1")], titleOf);
    notices.update([open("r1")], titleOf);
    notices.update([open("r1"), open("r2", "agent-2")], titleOf);
    expect(notify.mock.calls).toEqual([
      ["Computer action waiting", "Slack thread check: open Slack (com.tinyspeck.slackmacgap)"],
      ["Computer action waiting", "agent-2: open Slack (com.tinyspeck.slackmacgap)"],
    ]);
  });

  it("forgets a request once it is answered, so the list never grows", () => {
    const notify = vi.fn();
    const notices = new ApprovalNotices(notify);
    notices.update([open("r1")], titleOf);
    notices.update([], titleOf);
    notices.update([open("r1")], titleOf);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

type FakeNotification = { permission: "default" | "granted" | "denied"; requestPermission: () => Promise<"default" | "granted" | "denied">; shown: { title: string; body: string }[] };

function installNotification(permission: FakeNotification["permission"], answer: FakeNotification["permission"] = permission): FakeNotification {
  const shown: FakeNotification["shown"] = [];
  const api = class {
    static permission = permission;
    static requestPermission = async () => {
      api.permission = answer;
      return answer;
    };
    constructor(title: string, options: { body: string }) {
      shown.push({ title, body: options.body });
    }
  };
  vi.stubGlobal("Notification", api);
  return { get permission() { return api.permission; }, requestPermission: api.requestPermission, shown };
}

describe("desktop notifications", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows a notification when Paseo may notify, asking first if it has not been asked", async () => {
    const granted = installNotification("granted");
    desktopNotifier(vi.fn())("Computer action waiting", "body");
    expect(granted.shown).toEqual([{ title: "Computer action waiting", body: "body" }]);
    const asked = installNotification("default", "granted");
    desktopNotifier(vi.fn())("Computer action waiting", "after asking");
    await Promise.resolve();
    await Promise.resolve();
    expect(asked.shown).toEqual([{ title: "Computer action waiting", body: "after asking" }]);
  });

  it("reports once, and keeps working, when notifications are refused or missing", () => {
    installNotification("denied");
    const log = vi.fn();
    const notify = desktopNotifier(log);
    notify("Computer action waiting", "one");
    notify("Computer action waiting", "two");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("notifications are turned off for Paseo");
    vi.stubGlobal("Notification", undefined);
    const missingLog = vi.fn();
    expect(() => desktopNotifier(missingLog)("Computer action waiting", "three")).not.toThrow();
    expect(missingLog).toHaveBeenCalledTimes(1);
  });
});
