import { act, renderHook, waitFor } from "@testing-library/react";
import { disablePush, enablePush, getPushState } from "@/lib/push";
import { usePushControl } from "./use-push";

vi.mock("@/lib/push", () => ({
  disablePush: vi.fn(),
  enablePush: vi.fn(),
  getPushState: vi.fn(),
  isPushDisabledByUser: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getPushState).mockReset().mockResolvedValue({
    availability: "ready", subscribed: false, userDisabled: true,
  });
  vi.mocked(enablePush).mockReset();
  vi.mocked(disablePush).mockReset();
});

it("refreshes state and releases the busy flag when enabling throws, then allows retry", async () => {
  const { result } = renderHook(() => usePushControl());
  await waitFor(() => expect(result.current.state).not.toBeNull());
  const calls = vi.mocked(getPushState).mock.calls.length;
  vi.mocked(enablePush).mockRejectedValueOnce(new Error("push service unavailable"));
  await act(async () => {
    await expect(result.current.setEnabled(true)).rejects.toThrow("push service unavailable");
  });
  expect(result.current.busy).toBe(false);
  expect(getPushState).toHaveBeenCalledTimes(calls + 1);

  vi.mocked(enablePush).mockResolvedValueOnce({ ok: true });
  vi.mocked(getPushState).mockResolvedValueOnce({
    availability: "ready", subscribed: true, userDisabled: false,
  });
  await act(async () => {
    await expect(result.current.setEnabled(true)).resolves.toEqual({ ok: true });
  });
  expect(result.current.state?.subscribed).toBe(true);
  expect(result.current.busy).toBe(false);
});
