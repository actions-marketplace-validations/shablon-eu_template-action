#!/usr/bin/env bash
# Point the floating tags vMAJOR and vMAJOR.MINOR at the commit of a release tag vMAJOR.MINOR.PATCH.
#
# A floating tag is only moved if the release is the newest one in that line, so
# releasing a v1.0.5 hotfix after v1.1.0 updates v1.0 but leaves v1 on v1.1.0.
#
# Usage: update-floating-tags.sh <tag> [remote]
# Set DRY_RUN=1 to only print what would happen.
set -euo pipefail

tag="${1:?usage: $0 <tag> [remote]}"
remote="${2:-origin}"

if [[ ! "$tag" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "::error::'$tag' is not a release tag of the form vMAJOR.MINOR.PATCH (pre-releases don't move floating tags)."
  exit 1
fi
major="v${BASH_REMATCH[1]}"
minor="v${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"

commit="$(git rev-parse --verify "refs/tags/${tag}^{commit}")"

# Newest stable release matching a prefix, e.g. "v1." or "v1.0."
latest() {
  git tag --list "${1}*" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1
}

push=()
for floating in "$minor" "$major"; do
  newest="$(latest "${floating}.")"
  if [[ "$newest" != "$tag" ]]; then
    echo "Skipping ${floating}: ${newest} is newer than ${tag}."
    continue
  fi
  current="$(git rev-parse --verify --quiet "refs/tags/${floating}^{commit}" || true)"
  if [[ "$current" == "$commit" ]]; then
    echo "${floating} already points at ${tag} (${commit:0:7})."
    continue
  fi
  echo "Moving ${floating} -> ${tag} (${commit:0:7})${current:+, was ${current:0:7}}."
  git tag --force "$floating" "$commit"
  push+=("+refs/tags/${floating}:refs/tags/${floating}")
done

if [[ ${#push[@]} -eq 0 ]]; then
  echo "No floating tags to update."
elif [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "[dry run] would push: ${push[*]}"
else
  git push "$remote" "${push[@]}"
fi
