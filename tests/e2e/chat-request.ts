// Respect the real account rate limit when model-backed CI cases finish quickly.
export async function chatRequest(url: string, init: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (attempt || response.status !== 429) return response;
    const error = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (error.error?.code !== "CHAT_RATE_LIMITED") return response;
    await response.body?.cancel();
    console.log("Waiting for the local chat rate window before one retry.");
    await new Promise((resolve) => setTimeout(resolve, 60000));
    init.signal?.throwIfAborted();
  }
}
