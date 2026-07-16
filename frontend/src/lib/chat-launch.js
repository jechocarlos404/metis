/** Navigate to Chat with a pre-filled prompt (auto-sent on load). */
export function openChatWithPrompt(prompt) {
  const qs = new URLSearchParams({ prompt });
  window.location.href = `/chat?${qs}`;
}
