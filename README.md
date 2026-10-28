# SillyTavern Lovense Plus

Let your SillyTavern chats drive your toys: Lovense through Lovense Remote, or almost any brand through Intiface Central.

A fork of Marinara's [SillyTavern-Lovense](https://github.com/SpicyMarinara/SillyTavern-Lovense), reworked so the roleplay model never has to think about toys. The original readme is kept as [README_Legacy.md](README_Legacy.md).

Support the original author. These are Marinara's links:

***Get 55% OFF your Lovense order via Marinara's referral link: https://www.lovense.com/a/SpicyMarinara***

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da)](https://discord.com/invite/KdAkTg94ME)
[![Support Marinara](https://img.shields.io/badge/Ko--fi-Support%20Creator-ff5e5b)](https://ko-fi.com/marinara_spaghetti)

## 🆕 What's different from the original

In the original, the roleplay model had to write toy commands into its replies. That made it think about the toys *and* the scene at once, and it often burned through its output tokens before writing anything good.

This fork flips it around: **the roleplay model just roleplays.** Once a message has settled, a separate picker reads it and chooses a pattern from a library of 400+ patterns. Your toys react to the story without the chat model spending a single token on them.

- **Two ways to connect**: Lovense Remote (as before) or **Intiface Central**, which talks to toys over Bluetooth directly and supports most brands.
- **Two pickers**: free, instant keyword matching, or a separate cheap model through a SillyTavern Connection Profile.
- **Adapts to your toys automatically**: patterns use whatever each connected toy can do (vibrate, second motor, rotate, air pump, thrust).
- **Swipe-proof**: a configurable delay means only the message you keep sets the toys.
- **19 moods you can switch on and off**, from tease and edging to aftercare and 30-minute marathons.
- **Legacy Mode** keeps the original behaviour for anyone who prefers it.

## 📥 Installation

### 1. Install the Extension

In SillyTavern:
1. Go to **Extensions** → **Install Extension**
2. Paste the repository URL: `https://github.com/fyne4247/SillyTavern-Lovense-Plus`
3. Click **Install for all users/Install just for me**

### 2. Pick how to connect

| | Lovense Remote | Intiface Central |
| --- | --- | --- |
| Toys | Lovense only | Lovense and most other brands |
| Needs | Lovense Remote app + server plugin | Intiface Central app |
| Phone as the Bluetooth bridge | ✅ (Game Mode, same WiFi) | ❌ (Bluetooth on the computer running Intiface) |
| Air pump, dual motors, rotation | ✅ | ✅ |

> Lovense Remote for desktop is being phased out on some platforms. If it isn't available for you, use Intiface.

#### Option A: Intiface Central (no server plugin needed)

1. Install [Intiface Central](https://intiface.com/central/) and press the big **Start** button.
2. Turn your toy on. Intiface finds it over Bluetooth (close the Lovense app if it's holding the toy).
3. In SillyTavern: **Extensions** → **Lovense Control** → **Connect through: Intiface Central**.
4. Leave the address as `ws://127.0.0.1:12345` unless you changed it in Intiface, then click **Connect**.
5. Toggle **Enable Lovense Control**.

#### Option B: Lovense Remote (needs the server plugin)

The browser can't talk to Lovense Remote directly (CORS and self-signed certificates), so a small server plugin does it.

**Step 1: Enable server plugins** in your `config.yaml`:
```yaml
enableServerPlugins: true
```

![png](https://i.imgur.com/rmySG4N.png)

**Step 2: Copy the plugin file** from the extension's `server/` folder into SillyTavern's `plugins/` folder.

**Windows (PowerShell or Command Prompt):**
```batch
copy data\default-user\extensions\SillyTavern-Lovense-Plus\server\lovense.mjs plugins\
```

**Mac/Linux:**
```bash
cp data/default-user/extensions/SillyTavern-Lovense-Plus/server/lovense.mjs plugins/
```

(If you installed "for all users", the extension lives in `public/scripts/extensions/third-party/SillyTavern-Lovense-Plus/` instead.)

**Step 3: Restart SillyTavern completely.** You should see this in the server console:
```
Loading Lovense Control server plugin...
Lovense Control server plugin loaded successfully
```

**Step 4: Connect Lovense Remote**

- **PC:** install [Lovense Remote](https://www.lovense.com/app/remote), pair your toy, keep the app running, then click **Connect** in the extension and allow the third-party connection in the app. Defaults are `127.0.0.1` and port `30010`.
- **Mobile:** install Lovense Remote ([iOS](https://apps.apple.com/app/lovense-remote/id1273067916) / [Android](https://play.google.com/store/apps/details?id=com.lovense.remote)), pair your toy, put the phone on the **same WiFi** as your PC, then **Discover → Game Mode → Enable LAN**. Enter the IP and port it shows (e.g. `192.168.1.44`, usually port `20010`) and click **Connect**.

Toggle **Enable Lovense Control**. If you see **Status: Connected via …**, you're good to go!

## ✨ How It Works

### Choosing patterns

Pick a mode under **How patterns are chosen**:

- **Script** (default): matches the words in each message against every mood's keywords, and reads how intense the message is from its punctuation and pacing. Free and instant.
- **API**: a separate model reads each finished message and picks a mood and an intensity. Choose a **Connection Profile** (set one up in SillyTavern's Connection Manager first). A fast, cheap model is perfect; it only sees the message and a short mood list, never your chat history or character card. Optionally let it choose the exact pattern with a second small call. If its answer is unusable, Script mode steps in.
- **Legacy Mode**: the original behaviour, where the chat model writes commands into its replies. See [Legacy Mode](#legacy-mode) below.

### Timing

- **Delay after a message**: how long to wait once a message settles before picking. Swiping, editing or regenerating restarts the countdown, so heavy swipers don't get whiplash.
- **React to**: character messages, your own messages, or both.
- **Loop**: keep repeating the pattern until the next pick, or play it once and stop.
- **Min and Max Pattern Length**: 15 seconds up to 3 minutes, or no minimum / no limit. Automatic picks stay inside that range, so you can keep the 30-minute marathons out of quick scenes, or skip the short ones. "Try a pattern" ignores it.
- **Idle mood**: optionally switch to a calm mood if the chat goes quiet for a while.

### Moods

Patterns live in mood files, and each mood can be switched on or off. Switched-off moods are never picked and never sent to the picker model.

`tease` · `slow_build` · `edging` · `denial` · `rhythm` · `waves` · `chaos` · `intense` · `climax` · `aftercare` · `ambient` · `spikes` · `rough` · `oral` · `dance` · `overstim` · `classics` · `loops` · `marathons`

Use **Try a pattern** to feel any pattern by hand (each one shows its length and energy), and **Now Playing** to see what's running and why it was picked.

### Toys with more than one function

Every pattern step sets a vibration level and can optionally set the other channels (second motor, rotation, air pump, thrust). Channels a step doesn't mention follow the vibration level, scaled to that channel's range, so every pattern works on every toy, and toys with extra functions get them used on purpose where the pattern calls for it. Toys that connect or drop out mid-pattern are picked up automatically.

**Filter out specialized patterns** (on by default) hides the ones that would feel wrong on the toys you have connected. A pattern is specialized when a feature does its own thing for a few seconds, or for about a fifth of the pattern: two motors answering each other, a thrust line that isn't just the vibration, rotation that holds its own rhythm. If every connected toy lacks that feature, the pattern is skipped. Patterns that only vibrate, or that copy the vibration onto other features, still play. With nothing connected, nothing is hidden.

## Legacy Mode

With Legacy Mode on, the extension injects a system prompt that teaches the chat model how to control your device. The model uses XML-style tags that SillyTavern hides from the chat:

```xml
<lovense:vibrate="10" time="5"/>                 - Vibrate at 10 (0-20) for 5 seconds
<lovense:rotate="15" time="5"/>                  - Rotate at 15 (0-20)
<lovense:pump="2" time="5"/>                     - Pump at 2 (0-3)
<lovense:combo vibrate="10" pump="2" time="10"/> - Several functions at once
<lovense:preset name="pulse" time="10"/>         - pulse, wave, fireworks, earthquake
<lovense:pattern strength="5;10;15" interval="300" time="10"/>
<lovense:stop/>                                  - Stop all activity
```

Add `loop="5" pause="2"` to pulse on and off, or `device="name"` to target one toy. With streaming on, commands fire as they're generated; afterwards, all commands from the message loop until the next one. Customise the instructions under **Guidelines for the AI**.

On Intiface, legacy commands are translated into patterns. Presets map to similar moods from the library, and `stroke`/`depth` aren't available.

## 🎨 Adding patterns

Patterns are plain JSON in `patterns/<mood>.json`. The format and some notes on what makes a pattern feel good are in [`docs/PATTERN_FORMAT.md`](docs/PATTERN_FORMAT.md). After editing:

```bash
node tools/validate_patterns.mjs        # checks ranges, duplicates, lengths
node tools/build_pattern_index.mjs      # needed when you add or remove a mood file
```

## 📱 Supported Devices

- **Lovense Remote:** all Lovense devices the app supports. Toy functions come from the app when it reports them, with a built-in table otherwise (Nora/Ridge/Diamo rotate, Max pumps, Edge/Gemini/Dolce have two motors, Gravity/Solace thrust). The Flexer's fingering follows rotation, the Tenera's suction follows the air pump, and the Osci's oscillation follows thrust.
- **Intiface:** anything Intiface supports (see [IOSTIndex](https://iostindex.com)), with functions read from the device itself.

Tip for strong toys (Gush 2 and friends): the `classics` and `loops` moods include pulsed versions with long-on/short-off rhythms that are easier to take than a flat hum.

## 🔧 Troubleshooting

### Lovense Remote: "Server plugin not found" / HTTP 404

The server plugin isn't installed or loaded. Check that `lovense.mjs` is in SillyTavern's `plugins/` folder (on Windows, not `lovense.mjs.txt`), that `enableServerPlugins: true` is set, and that you fully restarted SillyTavern.

### Lovense Remote: device not connecting

- Keep Lovense Remote running and the toy paired there.
- Mobile: same WiFi, Game Mode LAN enabled, IP and port copied from the app.
- Click **Connect** again and accept the third-party prompt in the app.

### Intiface: can't connect

- Make sure Intiface Central is open **and** its server is started (the big button).
- If SillyTavern is opened over HTTPS or from another device, the browser may block the `ws://` connection. Open SillyTavern on the same computer as Intiface over plain `http://`.
- If Intiface says it's running but won't connect, stop and start its server, or restart the app.
- If a toy doesn't show up, close the Lovense app (only one app can hold a Bluetooth toy) and wake the toy.

### Nothing happens after a message

- Is **Enable Lovense Control** on and the status **Connected**?
- Is the right box ticked under **React to**?
- Script mode only reacts when a message matches some mood's keywords. Set **When nothing matches** to a mood if you want something to always play.
- API mode: check a Connection Profile is selected. Errors show as a toast, and the browser console (F12) has details.

## ⚙️ Privacy & Security

- Toy control happens **locally**: Lovense Remote over your LAN, or Intiface on your computer.
- **API mode** sends each message you react to (and a short list of moods) to whichever provider your chosen Connection Profile uses, just like a normal chat request. Script mode sends nothing anywhere.
- No developer account or Lovense API key required. No chat data is sent to Lovense.

## 📋 Known Limitations

- **Mobile Lovense Remote** needs the phone and PC on the same WiFi network.
- **Intiface** needs Bluetooth on the computer it runs on.
- Lovense's LAN API can't follow changes much faster than about a third of a second, so patterns stay at or above that.

## 💖 Contributing

Contributions are welcome! Please feel free to submit issues or pull requests. Run the tests before sending changes:

```bash
node --test tests/
node tools/validate_patterns.mjs
```

## 📜 License

This extension is provided as-is for use with SillyTavern. Please ensure you comply with Lovense's API terms of service.

## 🙏 Credits

- Original extension by Marinara ([SillyTavern-Lovense](https://github.com/SpicyMarinara/SillyTavern-Lovense))
- Picker, Intiface support and pattern library by [fyne4247](https://github.com/fyne4247)
- Solace Pro support by [mccrypt1](https://github.com/mccrypt1)
- Built for [SillyTavern](https://github.com/SillyTavern/SillyTavern)
- Uses [Lovense Standard Solutions API](https://github.com/lovense/Standard_solutions) and [Buttplug / Intiface](https://buttplug.io)

---

**Disclaimer**: This is a community-made extension for adult users only. By downloading it, you agree to be 18 or older. Use responsibly and at your own discretion. The developers are not responsible for any misuse or issues arising from the use of this extension.

