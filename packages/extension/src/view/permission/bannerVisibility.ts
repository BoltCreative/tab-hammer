// Whether the "allow previews" banner should render, given the last permission check.
// `null` means the check hasn't resolved yet: treated as hidden so the banner never flashes on
// for a still-loading view that turns out to already be granted.
export function shouldShowBanner(granted: boolean | null): boolean {
  return granted === false;
}
