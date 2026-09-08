import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { registerPushSubscription } from "./api";

const body = {
  endpoint: "https://push.example.test/device",
  keys: { p256dh: "test-key", auth: "test-auth" },
};

it("registers push with the API's XHR header and accepts the bridge's empty acknowledgement", async () => {
  let received: unknown;
  let xhr: string | null = null;
  server.use(http.post("/api/subscribe", async ({ request }) => {
    received = await request.json();
    xhr = request.headers.get("X-Requested-With");
    return new HttpResponse(null, { status: 204 });
  }));
  await expect(registerPushSubscription(body)).resolves.toBeUndefined();
  expect(received).toEqual(body);
  expect(xhr).toBe("XMLHttpRequest");
});

it.each([401, 403, 500])("rejects a failed push registration with status %s", async (status) => {
  server.use(http.post("/api/subscribe", () => new HttpResponse("refused", { status })));
  await expect(registerPushSubscription(body)).rejects.toMatchObject({ status });
});

it("treats a sign-in redirect as an authentication failure, not a successful registration", async () => {
  server.use(http.post("/api/subscribe", () =>
    new HttpResponse(null, { status: 302, headers: { Location: "/auth/sign-in" } }),
  ));
  await expect(registerPushSubscription(body)).rejects.toMatchObject({ status: 401 });
});
