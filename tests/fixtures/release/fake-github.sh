# This file is sourced by Bash through BASH_ENV. Keep its effects limited to
# these exported functions and one provenance marker.
SANA_FAKE_GITHUB_BASH_ENV_V1="${BASH_SOURCE[0]}"
export SANA_FAKE_GITHUB_BASH_ENV_V1

gh() (
  if [[ -z "${FAKE_GITHUB_BUN-}" || -z "${FAKE_GITHUB_HANDLER-}" ]]; then
    printf '%s\n' 'fake-github: simulator command authority is missing' >&2
    exit 70
  fi
  exec "${FAKE_GITHUB_BUN}" "${FAKE_GITHUB_HANDLER}" invoke gh -- "$@"
)
export -f gh

sleep() (
  if [[ -z "${FAKE_GITHUB_BUN-}" || -z "${FAKE_GITHUB_HANDLER-}" ]]; then
    printf '%s\n' 'fake-github: simulator command authority is missing' >&2
    exit 70
  fi
  exec "${FAKE_GITHUB_BUN}" "${FAKE_GITHUB_HANDLER}" invoke sleep -- "$@"
)
export -f sleep
