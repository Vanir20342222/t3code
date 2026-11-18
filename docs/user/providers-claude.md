# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

On mobile, tap **Add Claude account** in **Settings > Providers** and enter a name and the
config folder. The login itself still happens on the environment's machine.

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

File paths in the `--settings` and `--append-system-prompt-file` launch arguments
can start with `~` for the home directory of the machine running T3 Code. Any
other relative path is read from the thread's project folder, or its worktree.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Claude Code also
compacts automatically. To see context usage, see
[commands and skills](./composer.md#commands-and-skills).

When you return to a large thread after Claude's prompt cache expires, a
**Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Keep** and keep the full
history for that message. The mobile app shows no chip: an eligible message sent
from it summarizes first. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

**Compact idle threads** in **Settings > Providers > Advanced** controls this for threads
over 200,000 tokens. Each Claude provider's settings can override it:

- **When you return** shows the **Compact** chip described above. This is the default.
- **Before the cache expires (beta)** tries to compact an idle thread shortly before its
  prompt cache expires, while the history is still cached.
  The compaction appears in the thread as a `/compact` turn sent by T3 Code.
  If the window is missed, such as when you enable this mode after the cache has
  expired or the server restarts before compaction runs, it falls back to
  **When you return**. Switch the chip to **Keep** to keep the full history for that message.
- **Never** skips idle compaction and Claude's resume prompt. **Auto-compact after**
  still applies, and you can still compact by hand.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins,
and plugins synced from your claude.ai account, also contribute skills under
names such as `plugin:review`. Skills marked `disable-model-invocation` can
still be started by you. Invoke those one per message: Claude directly runs only
the last named skill and may try to start earlier ones through its Skill tool,
which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers**. Each update shows as a Tasks
row in the thread; open it to see every step.

## Claude in Chrome

Claude threads can use the Claude in Chrome extension, which works in your own
Chrome with its sign-ins. T3 Code sessions load it only when asked: add `--chrome`
to **Launch arguments** in the Claude instance's settings in **Settings > Providers**.
It applies to sessions that start after you save. Set up the extension as you would
for Claude Code first; see Claude Code's [Chrome guide](https://code.claude.com/docs/en/chrome).

The instance must be signed in with `/login` on a direct Anthropic plan. Instances
that use an API key or a `claude setup-token` token don't get it, even with
`--chrome`, and neither do third-party providers such as Amazon Bedrock. Claude Code
doesn't support it in WSL.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.

## Run sessions in Claude Cloud

Claude Cloud is a beta: turn on **Cloud sessions** in **Settings → Labs** first.
T3 starts sessions with the Claude Code CLI, but reads replies and changes
settings through a private Anthropic interface using Claude Code's sign-in.
Anthropic's terms restrict other apps from using Claude sign-ins this way, and
it can be changed or blocked without notice, which may affect your account.
Every Claude account is also checked for cloud access when T3 starts.

When starting a chat, open the machine picker and choose **Claude Cloud**. Each
configured Claude Code account has its own cloud choice, using that account's
login and custom config directory. A Claude subscription and cloud-session
access are required; API keys and third-party model providers do not grant it.
Run `claude` once in a terminal on that machine first, so Claude Code's
first-run setup does not block the cloud session from starting.

With Claude Cloud chosen, the model picker lists only Claude Cloud models. The
first message creates a cloud session with the model, effort level, and Ultracode
setting chosen in the composer. Claude's replies, commands, and file edits stream back into the
thread, and follow-ups continue the same session, including after restarting T3.
Picking another model, effort level, or Ultracode setting before a follow-up switches the cloud
session to it. Fast mode is not available, because cloud sessions do not accept it.
Changed files stay in the cloud session's branch; open the session at
[claude.ai/code](https://claude.ai/code) to review or open a pull request.
Replies are read with the Claude Code sign-in file on this machine. Where the
sign-in lives only in the macOS keychain, T3 sends messages and links to the
session instead of showing replies.

For GitHub-backed sessions, push the branch before sending so Claude can clone
your changes. To bring a completed session's branch and conversation back to a
local terminal, run `claude --teleport <session id>` from a clean checkout of
the repository. Teleport creates a local copy; later local messages do not sync
back to the cloud session.
