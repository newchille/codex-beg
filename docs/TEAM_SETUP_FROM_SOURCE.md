# Codex BEG — setup from GitHub checkout

ใช้เอกสารนี้เมื่อทีมต้อง clone repository แล้ว build/install เองบน macOS Apple Silicon

## 1. Clone และติดตั้งแอป

```bash
git clone https://github.com/newchille/codex-beg.git
cd gpt-mcp
./scripts/build-install-macos.sh --install-deps --launch
```

ถ้าเครื่องมี Node.js 22+ และ pnpm อยู่แล้ว ให้ตัด `--install-deps` ออก:

```bash
./scripts/build-install-macos.sh --launch
```

สคริปต์จะ:

1. ตรวจว่าเป็น macOS arm64
2. ติดตั้ง dependency ด้วย `pnpm install --frozen-lockfile`
3. build package ด้วย `pnpm package`
4. ติดตั้ง `Codex BEG.app` ไปที่ `~/Applications`
5. ไม่ใช้ `sudo` และไม่แตะ project files นอก repository

ถ้ามีแอปเดิมอยู่แล้ว สคริปต์จะหยุดเพื่อไม่เขียนทับโดยไม่ตั้งใจ ใช้ `--replace` เมื่อต้องการย้ายแอปเดิมไปเป็น backup แล้วติดตั้งตัวใหม่:

```bash
./scripts/build-install-macos.sh --replace --launch
```

เปิดแอปแล้วไปที่ **Doctor → Run checks** ต้องเห็น Agent Host running และ endpoint เป็น `http://127.0.0.1:43123/mcp`

## 2. ติดตั้ง tunnel-client

```bash
./scripts/setup-tunnel-client.sh
```

ถ้าจะให้ Codex CLI ช่วยจัดการ tunnel ด้วย ให้ติดตั้ง official Tunnel MCP plugin เพิ่ม:

```bash
./scripts/setup-tunnel-client.sh --with-codex-plugin
```

plugin เป็น optional และไม่จำเป็นสำหรับ ChatGPT Connector โดยตรง

## 3. เตรียม Runtime API key

ผู้ดูแล Platform ต้องเตรียม tunnel และ Runtime API key ให้ผู้ใช้แต่ละคน/แต่ละเครื่อง โดย key ต้องมี Tunnels **Read + Use** เท่านั้น

```bash
KEY_FILE="$HOME/.config/codex-beg/secrets/control-plane-api-key"
install -d -m 700 "$HOME/.config/codex-beg/secrets"
umask 077
printf 'Runtime API key (input hidden): '
IFS= read -r -s CONTROL_PLANE_API_KEY
printf '\n'
printf '%s' "$CONTROL_PLANE_API_KEY" > "$KEY_FILE"
unset CONTROL_PLANE_API_KEY
chmod 600 "$KEY_FILE"
```

ห้ามใส่ key ลงใน Git, command argument, chat หรือ screenshot

## 4. ตั้งค่าต่อเครื่องและเชื่อม tunnel

ตั้งค่า `tunnel_id` ของเครื่องนั้น และชี้ไปที่ key file:

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_0123456789abcdef0123456789abcdef'
export CONTROL_PLANE_API_KEY_FILE="$HOME/.config/codex-beg/secrets/control-plane-api-key"
export TUNNEL_CLIENT_ALIAS='codex-beg'
```

ตรวจว่าแอปเปิดอยู่แล้วรัน:

```bash
./scripts/run-tunnel-client.sh
```

สคริปต์จะตรวจ local health, เรียก `tunnel-client runtimes connect`, แล้วตรวจ `runtimes status --json` ต่อทันที โดยไม่พิมพ์ API key ออกมา

ถ้าต้องการใช้ environment variable ชั่วคราวแทนไฟล์:

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
printf 'Runtime API key (input hidden): '
IFS= read -r -s CONTROL_PLANE_API_KEY
printf '\n'
export CONTROL_PLANE_API_KEY
./scripts/run-tunnel-client.sh
unset CONTROL_PLANE_API_KEY
```

## 5. ต่อ ChatGPT Connector

1. เปิด ChatGPT → **Settings → Connectors**
2. เลือก **Connection: Tunnel**
3. เลือก/ใส่ `tunnel_id` เดียวกับที่ตั้งในเครื่องนี้
4. คง Codex BEG และ managed tunnel runtime ให้ `healthy`/`ready`
5. ทดสอบด้วย `workspace_list` ก่อน แล้วค่อย register project

## 6. โมเดลแยกต่อคน/ต่อเครื่อง

ใช้ DMG/source code ชุดเดียวกันได้ แต่ต้องแยกค่าต่อเครื่อง:

```text
Alice Mac  → tunnel_id_A + runtime_key_A + connector_A
Bob Mac    → tunnel_id_B + runtime_key_B + connector_B
```

อย่าให้ทุกคนใช้ tunnel เดียวหรือ Runtime API key เดียว เพราะ connector จะชี้ไปยัง MCP endpoint ของเครื่องที่ผูกกับ tunnel นั้น

## 7. หยุดและเริ่มใหม่

หยุด runtime ที่จัดการโดย tunnel-client:

```bash
tunnel-client runtimes stop "${TUNNEL_CLIENT_ALIAS:-codex-beg}"
```

หลัง reboot ให้เปิด Codex BEG ก่อน แล้วรัน `./scripts/run-tunnel-client.sh` ใหม่ถ้า status ไม่ได้เป็น running/healthy/ready

Official references:

- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [tunnel-client end-user guide](https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md)
- [Tunnel MCP plugin](https://github.com/openai/tunnel-client/blob/master/plugins/tunnel-mcp/README.md)
