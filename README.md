# opencode-rate-limit-fallback

OpenCode plugin that automatically switches to a fallback model when rate limits are hit.

## Installation

Add to your `opencode.jsonc`:

```json
{
  "plugin": ["opencode-rate-limit-fallback"]
}
```

## Configuration

Create `rate-limit-fallback.json` in your OpenCode config directory:

**Locations checked (in order):**
1. `~/.config/opencode/rate-limit-fallback.json`
2. `~/.config/opencode/config/rate-limit-fallback.json`
3. `~/.config/opencode/plugins/rate-limit-fallback.json`
4. `~/.config/opencode/plugin/rate-limit-fallback.json`

**Example config:**

```json
{
  "enabled": true,
  "fallbackModel": "anthropic/claude-opus-4-5",
  "cooldownMs": 300000,
  "patterns": [
    "rate limit",
    "usage limit",
    "too many requests",
    "quota exceeded",
    "overloaded"
  ],
  "logging": true
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `fallbackModel` | string \| object | `"anthropic/claude-opus-4-5"` | Fallback model (see formats below) |
| `cooldownMs` | number | `300000` | Cooldown period in ms (default: 5 minutes) |
| `patterns` | string[] | (see below) | Custom rate limit detection patterns |
| `logging` | boolean | `false` | Enable file-based logging |

### Fallback Model Formats

**String format (recommended):**
```json
{
  "fallbackModel": "anthropic/claude-opus-4-5"
}
```

### Custom Patterns

Add your own rate limit detection patterns:

```json
{
  "patterns": [
    "rate limit",
    "usage limit",
    "too many requests",
    "quota exceeded",
    "overloaded",
    "capacity exceeded"
  ]
}
```

Patterns are case-insensitive and matched against the retry message.

### Logging

When `logging: true`, logs are written to:
```
~/.local/share/opencode/logs/rate-limit-fallback.log
```

Log entries include timestamps and details about rate limit detection, fallback attempts, and errors.

## How It Works

1. **Detection**: Listens for `session.status` events with retry messages matching configured patterns.

2. **Fallback**: When detected:
   - Aborts the current retry loop
   - Retrieves the last user message from the session
   - Reverts the session to before that message (removing the failed attempt)
   - Re-sends the original message with the fallback model
   - Starts a cooldown timer

3. **Cooldown**: During the cooldown period, subsequent rate limits on the same session are ignored (prevents spam). After cooldown expires, normal model selection resumes.

This approach keeps the conversation history clean - no "continue" messages or duplicates. The session seamlessly continues with the fallback model as if the rate limit never happened.

## Local Development

For local development, use a `file://` URL in your config:

```json
{
  "plugin": [
    "file:///path/to/opencode-rate-limit-fallback/index.ts"
  ]
}
```

## License

MIT
