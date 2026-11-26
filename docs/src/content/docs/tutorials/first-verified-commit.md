---
title: Your first Verified commit
description: Set up graft on a sandbox repository and publish a change as a GitHub App.
sidebar:
  order: 1
---

In this tutorial we will give a sandbox repository its own GitHub App and publish a change through it. At the end you will have a pull request whose commit GitHub shows as **Verified**, authored by the App rather than by you.

It takes about fifteen minutes.

## Before you start

You need:

- macOS or Linux with Node 22 or newer (`node --version`).
- A GitHub account.
- A new, empty repository you own, created on GitHub **with a README**. We will call it `you/sandbox`. Use a throwaway: setup adds rules to its `main` branch.
- The [GitHub CLI](https://cli.github.com/) signed in as yourself (`gh auth status`). Setup uses it to write the branch rules.

Clone the sandbox over HTTPS and step into it:

```sh
git clone https://github.com/you/sandbox.git
cd sandbox
```

## 1. Install graft

```sh
npm install -g @oakgreencc/graft
graft --version
```

You will see a version number such as `0.2.21`.

## 2. Create the App

```sh
graft setup app
```

Your browser opens GitHub's "create App" page with the permissions already filled in. Click **Create GitHub App**. GitHub then shows the install page: choose **Only select repositories**, pick `sandbox`, and install.

Back in the terminal, graft reports that it saved the App's private key under `~/.oakgreen/graft/apps/`.

## 3. Bootstrap the repository

```sh
graft setup project --no-claude --validate "test -f hello.txt"
```

Accept the default answer to each question. graft writes `.graft.json` and `CODEOWNERS`, then adds a ruleset named `graft: main` on GitHub.

Leave the two new files uncommitted for now. We will publish only our own change.

## 4. Check the setup

```sh
graft doctor
```

Every line should start with `✓`. A line with `✗` names its own fix; run it and check again.

## 5. Make a change

```sh
echo "Hello from graft" > hello.txt
graft validate
```

`graft validate` runs the command you gave setup and records which `main` it was green against. It exits 0.

## 6. See a refusal

Try to publish without saying what to publish:

```sh
graft publish agent/hello "docs: say hello"
```

graft refuses and lists every changed path, including `.graft.json` and `CODEOWNERS`. Nothing reached GitHub. graft never sweeps up files you did not name.

## 7. Publish

```sh
graft publish agent/hello "docs: say hello" --paths hello.txt --pr "Say hello"
```

Notice the output: a `commit:` line ending in `[Verified]`, and a `pr:` line with a URL.

Open that URL. On the **Commits** tab the commit carries a green **Verified** badge, and its author is the App, `you-agents[bot]`, not you.

## 8. Merge and confirm

Merge the pull request with GitHub's **Merge** button. Then ask graft whether anything here is missing from GitHub:

```sh
graft status agent/hello
```

You will see `nothing local that GitHub does not have`. Your work is safe on GitHub.

## What you did

You created a GitHub App, held a repository's `main` to rules the App cannot change, and published a change that GitHub itself signed. You also saw graft refuse an ambiguous publish before it wrote anything.

## Next

- [Run your first agent task](/tutorials/first-agent-task/) on the same sandbox.
- [Set up graft on a real repository](/how-to/set-up-graft-on-a-repository/), including committing the setup files.
- [Why GitHub is the boundary](/explanation/boundary-and-tripwires/).
