#!/usr/bin/env bash
# bash script which tags the current commit with a calver version
# and pushes the tag to the remote repository

set -euo pipefail

# Define color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

TARGET_BRANCH="${MANABITAN_RELEASE_BRANCH:-main}"

if [[ $(git branch --show-current) != "${TARGET_BRANCH}" ]]; then
    echo -e "${RED}Please only tag commits on ${TARGET_BRANCH} branch.${NC}"
    exit 1
fi

echo -e "${YELLOW}Checking if branch is up to date...${NC}"

if [[ -n $(git status --porcelain --untracked-files=normal) ]]; then
    echo -e "${RED}Commit or preserve working changes before tagging.${NC}"
    exit 1
fi
for operation in MERGE_HEAD CHERRY_PICK_HEAD REBASE_HEAD; do
    if [[ -f $(git rev-parse --git-path "$operation") ]]; then
        echo -e "${RED}Finish the in-progress Git operation before tagging.${NC}"
        exit 1
    fi
done
if [[ -d $(git rev-parse --git-path rebase-merge) || -d $(git rev-parse --git-path rebase-apply) ]]; then
    echo -e "${RED}Finish the in-progress rebase before tagging.${NC}"
    exit 1
fi
git fetch --prune origin
remote_revision=$(git rev-parse --verify "refs/remotes/origin/${TARGET_BRANCH}")
if [[ $(git rev-parse HEAD) != "$remote_revision" ]]; then
    echo -e "${RED}Push or reconcile ${TARGET_BRANCH} with origin before tagging; their commits must match.${NC}"
    exit 1
fi

release_revision=$(git rev-parse HEAD)

# Ask user to confirm the commit and the tag name
echo -e "${YELLOW}Current HEAD of ${TARGET_BRANCH} branch:${NC}"
git log -1 --decorate "$release_revision"
echo

# get the current date in the format YY.MM.DD
DATE=$(date +%y.%-m.%-d)

# Check if the tag already exists and increment if necessary
COUNTER=0
TAG=$DATE.$COUNTER
while git rev-parse "$TAG" >/dev/null 2>&1; do
    # Increment the counter and recreate TAG with DATE
    echo -e "${YELLOW}Tag $TAG already exists, incrementing.${NC}"
    COUNTER=$((COUNTER + 1))
    TAG="$DATE.$COUNTER"
done
echo
echo -e -n "${YELLOW}Tagging current HEAD of ${TARGET_BRANCH} with tag ${TAG}. Are you sure? (y/n): ${NC}"
read -p "" -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Tagging aborted.${NC}"
    exit 1
fi

git tag -s "${TAG}" "$release_revision"

echo -e -n "${YELLOW}Do you want to push the tag ${TAG} to the remote repository? (y/n): ${NC}"
read -p "" -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Push aborted.${NC}"
    exit 1
fi

git push origin "${TAG}"
echo -e "${GREEN}Pushed tag ${TAG}.${NC}"
