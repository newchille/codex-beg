# Codex BEG — คู่มือติดตั้งและใช้งานสำหรับทีม

เอกสารนี้ใช้กับชุดแจก **Codex BEG สำหรับ macOS Apple Silicon (arm64)** โดยเริ่มตั้งแต่เครื่องยังไม่เคยติดตั้งมาก่อน

ภาพรวมการทำงาน:

```text
ChatGPT Connector
        ↓ Secure MCP Tunnel
tunnel-client บนเครื่องผู้ใช้
        ↓ http://127.0.0.1:43123/mcp
Codex BEG Agent Host
        ↓
โปรเจกต์บนเครื่องผู้ใช้
```

Codex BEG ไม่ต้องใช้ source repository, Node.js, npm, pnpm, TypeScript หรือ Codex CLI บนเครื่องทีม และไม่มี raw shell MCP tool

## 1. สิ่งที่ทีมต้องเตรียม

สำหรับผู้ใช้แต่ละคน:

- Mac Apple Silicon; ตรวจด้วย `uname -m` ต้องได้ `arm64`
- แอป Codex BEG จากไฟล์ DMG นี้
- `tunnel_id` ของ tunnel ที่องค์กรเตรียมไว้
- Runtime API key แยกต่อคน/ต่อเครื่อง โดยมีสิทธิ์เฉพาะ Tunnels **Read + Use**
- สิทธิ์ ChatGPT Developer Mode / Connectors จาก workspace administrator

สำหรับผู้ดูแล Platform ทำครั้งเดียว:

- เตรียมหรือสร้าง tunnel และผูกกับ ChatGPT workspace ที่ถูกต้อง
- ออก Runtime API key แบบ restricted ให้ผู้ใช้แต่ละคน
- ไม่แจก `OPENAI_ADMIN_KEY` ให้ผู้ใช้ทั่วไป; admin key ใช้จัดการ tunnel CRUD เท่านั้น

ค่าที่ต้องแยกกัน:

```text
TUNNEL_ID=tunnel_0123456789abcdef0123456789abcdef  # identifier ไม่ใช่ secret
RUNTIME_API_KEY=<secret>                            # ห้ามใส่ในแชตหรือเอกสาร
```

เอกสารทางการ:

- [Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels)
- [Runtime API keys](https://platform.openai.com/settings/organization/api-keys)
- [tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest)
- [ChatGPT Plugins](https://chatgpt.com/plugins)

## 2. ติดตั้ง Codex BEG

1. เปิดไฟล์ `Codex-BEG-0.1.0-mac-arm64.dmg`
2. ลาก `Codex BEG.app` ไปที่โฟลเดอร์ `Applications`
3. Eject DMG แล้วเปิด `Codex BEG` จาก Finder หรือ Launchpad

ตรวจไฟล์ก่อนแจก/ติดตั้งได้ด้วย:

```bash
shasum -a 256 Codex-BEG-0.1.0-mac-arm64.dmg
```

ถ้า macOS แจ้งว่าเปิดแอปไม่ได้เพราะยังไม่ notarized:

1. คลิกขวา `Codex BEG.app` → **Open**
2. ถ้ายังถูกบล็อก ไปที่ **System Settings → Privacy & Security → Open Anyway**
3. เปิดผ่าน Finder อีกครั้ง

นี่เป็น development distribution แบบ adhoc/unsigned จึงต้องทำขั้นตอน UI นี้บนเครื่องใหม่ ห้ามปิด Gatekeeper ทั้งระบบและห้ามลบ quarantine แบบครอบจักรวาล

ถ้าต้องการ build จาก GitHub checkout แทนการใช้ DMG ให้เปิด `docs/TEAM_SETUP_FROM_SOURCE.md` ใน repository แล้วรัน `./scripts/build-install-macos.sh --install-deps --launch`

## 3. ตรวจ Codex BEG หลังเปิดครั้งแรก

1. เปิดหน้า **Doctor**
2. กด **Run checks**
3. ต้องเห็น Agent Host เป็น running
4. endpoint ภายในต้องเป็น:

```text
http://127.0.0.1:43123/mcp
```

ตรวจจาก Terminal ได้:

```bash
curl -fsS http://127.0.0.1:43123/healthz
```

ถ้า Agent Host ค้างหรือข้อมูล tool catalog เก่า ให้ใช้ **Doctor → Restart Agent Host** ในแอปเดียวกัน อย่าเปิด Codex BEG ซ้อนหลาย instance

Admin token ที่แอปใช้ภายในสร้างใหม่ทุก session และไม่ใช่ OpenAI API key ผู้ใช้ไม่ต้องหา ไม่ต้อง copy และไม่ต้องใส่ใน tunnel-client

## 4. ติดตั้ง tunnel-client

วิธีแนะนำถ้ามี Homebrew:

```bash
brew install openai/tools/tunnel-client
tunnel-client --version
tunnel-client help quickstart
```

ถ้าไม่มี Homebrew ให้ดาวน์โหลด macOS arm64 binary จาก [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) หรือ [official releases](https://github.com/openai/tunnel-client/releases/latest) แล้วติดตั้งไว้ใน PATH ของผู้ใช้ เช่น:

```bash
mkdir -p "$HOME/bin"
chmod 700 "$HOME/bin/tunnel-client"
export PATH="$HOME/bin:$PATH"
tunnel-client --version
```

อย่าดาวน์โหลด binary จากสูตรหรือเว็บไซต์ที่ไม่ใช่แหล่งทางการ และ Codex BEG ไม่ได้ bundle tunnel-client มาให้

## 5. เตรียม tunnel ID และ Runtime API key

ผู้ดูแลส่งให้ผู้ใช้:

- tunnel ID ที่ผูกกับ ChatGPT workspace แล้ว
- Runtime API key ของผู้ใช้นั้นเอง

Runtime API key ต้องมีเพียง:

- Tunnels: **Read**
- Tunnels: **Use**

เก็บ key ในไฟล์ที่อ่านได้เฉพาะ user คนปัจจุบัน:

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
stat -f '%A %N' "$KEY_FILE"
```

ผล permission ต้องเป็น `600` และไฟล์ต้องมีเฉพาะ key ไม่มี label, quote หรือ newline เพิ่มเติม

ห้ามใส่ key ลงใน command history, screenshot, ticket, YAML แบบ literal หรือ ChatGPT prompt

## 6. เชื่อม runtime ของเครื่องนี้เข้ากับ tunnel

เปิด Codex BEG ค้างไว้ก่อน แล้วตรวจ local endpoint:

```bash
curl -fsS http://127.0.0.1:43123/healthz
```

ตั้งค่าเฉพาะ tunnel ID ซึ่งไม่ใช่ secret:

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_0123456789abcdef0123456789abcdef'
KEY_FILE="$HOME/.config/codex-beg/secrets/control-plane-api-key"
```

สำหรับการใช้งานประจำวัน ให้ใช้ managed runtime ของ tunnel-client:

```bash
tunnel-client runtimes connect \
  --alias codex-beg \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --runtime-api-key "file:$KEY_FILE" \
  --mcp-server-url http://127.0.0.1:43123/mcp
```

ตรวจให้ครบก่อนรายงานว่าสำเร็จ:

```bash
tunnel-client runtimes status codex-beg --json
```

ต้องเห็น process running, healthy และ ready ตาม field ที่ client แสดง อย่าใช้ `nohup` หรือ `disown` เป็นวิธี supervision หลัก

ถ้า binary รุ่นที่ติดตั้งไม่มี `runtimes` command ให้ดูคำสั่งที่ binary รองรับก่อน:

```bash
tunnel-client help quickstart
```

จากนั้นใช้ foreground profile flow ตามเอกสารของรุ่นนั้น โดยทั่วไปคือ `init`, `doctor --explain`, แล้ว `run`; ต้องเปิด Terminal นี้ค้างไว้

## 7. ตรวจ tunnel health

Codex BEG ต้องตอบ:

```bash
curl -fsS http://127.0.0.1:43123/healthz
```

tunnel-client โดยปกติเปิด operator health ที่ `127.0.0.1:8080`:

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
open http://127.0.0.1:8080/ui
```

`healthz` แปลว่า process ยังอยู่; `readyz` ต้องผ่านก่อนทดสอบ ChatGPT connector ถ้า client แสดง health URL อื่น ให้ใช้ URL ที่ status รายงาน

## 8. สร้าง MCP app/plugin ใน ChatGPT

1. คง Codex BEG และ tunnel-client ให้ running/ready
2. เปิด [ChatGPT Plugins](https://chatgpt.com/plugins)
3. กด `+` เพื่อสร้าง developer-mode app (หรือไปที่ **Apps → Create** ตาม UI/workspace)
4. เลือก **Tunnel** ในช่อง Connection
5. เลือก tunnel ที่เตรียมไว้ หรือ paste `tunnel_id` เดียวกับข้อ 6
6. กรอก metadata, กด **Scan Tools**, แล้วกด **Create**
7. เปิดแชตใหม่ แล้วเลือก draft app จากเมนู Tools เพื่อทดสอบ

ถ้า tunnel ไม่ปรากฏ ให้ตรวจว่า:

- tunnel ผูกกับ ChatGPT workspace ถูกตัว ไม่ใช่แค่องค์กร Platform
- connector operator มี Tunnels Read + Use
- `tunnel-client runtimes status codex-beg --json` เป็น healthy/ready
- `curl http://127.0.0.1:8080/readyz` ได้ HTTP 200

## 9. ทดสอบครั้งแรกแบบปลอดภัย

ให้เริ่มจาก read-only เท่านั้น:

1. ใน ChatGPT เลือก Codex BEG connector
2. เรียก `workspace_list`
3. เปิดหน้า **Projects** ใน Codex BEG
4. ถ้าต้องการโฟลเดอร์รวมหลาย repo ให้กด **Add machine root**
5. เพิ่ม repo จริงทีละตัวด้วย **Register child project**
6. เลือก project child ที่ต้องการใช้งาน
7. ทดสอบ `git_status`, `workspace_tree` หรือ project `typecheck`

การเพิ่ม machine root หรือ project ใหม่คือ capability grant และต้องมี approval ตาม safety flow ของแอป ตรวจ path ให้ถูกก่อนกด approve

อย่าเริ่มต้นด้วย write, Git commit, restore หรือ operation ที่ทำลายข้อมูล

## 10. วิธีใช้งานประจำวัน

```text
1. เปิด Codex BEG
2. Doctor → Run checks
3. ตรวจ tunnel-client runtimes status ... --json
4. ต้องเห็นทั้ง local health และ tunnel ready
5. เปิด ChatGPT connector
6. เริ่ม workspace_list แล้วค่อยเลือก project
```

ในหน้า Codex BEG:

- **Home**: ดูภาพรวม Agent/MCP และสถานะปัจจุบัน
- **Projects**: เพิ่ม/เลือก project และ machine root
- **Live Logs**: ดู operation, approval และ recovery ที่ผ่านมา
- **Doctor**: ตรวจ health และ Restart Agent Host
- **Settings**: ดูค่าการทำงานที่แอปเปิดเผยให้ผู้ใช้

หลังแก้ schema หรือ rebuild Agent Host ให้กด **Doctor → Restart Agent Host** แล้ว refresh/reconnect connector ใน ChatGPT เพื่อให้ tool catalog ใหม่ถูกโหลด

## 11. หลัง reboot หรือ sleep

```bash
open -a "Codex BEG"
curl -fsS http://127.0.0.1:43123/healthz
tunnel-client runtimes status codex-beg --json
```

ถ้า runtime ไม่ได้ running/healthy/ready ให้รันคำสั่ง `runtimes connect` ในข้อ 6 ใหม่ คู่มือนี้ไม่ติดตั้ง LaunchAgent อัตโนมัติ จึงไม่ควร assume ว่าจะ start เองหลัง reboot

## 12. หยุดใช้งานและถอนการติดตั้ง

หยุด tunnel runtime:

```bash
tunnel-client runtimes stop codex-beg
```

จากนั้น quit Codex BEG และย้าย `Codex BEG.app` ไป Trash จาก Finder หากต้องการถอนการติดตั้ง

การลบแอปไม่ลบ project files โดยอัตโนมัติ อย่าลบ tunnel ใน Platform เว้นแต่เป็นเจ้าของและตั้งใจยกเลิกให้ทุกคน

## 13. Troubleshooting เร็ว

### แอปเปิดไม่ได้

ใช้ Finder → คลิกขวา → Open แล้วตรวจ Privacy & Security → Open Anyway; ตรวจ `uname -m` ต้องเป็น `arm64`

### Port 43123 ถูกใช้

```bash
lsof -nP -iTCP:43123 -sTCP:LISTEN
```

ปิด Codex BEG instance ที่เป็นของทีมเอง แล้วเปิดเพียงหนึ่ง instance; อย่าฆ่า PID ที่ไม่รู้จัก

### `tunnel-client: command not found`

```bash
command -v tunnel-client
brew install openai/tools/tunnel-client
tunnel-client --version
```

### ได้ 401 จาก `/admin/*`

เป็นเรื่องปกติ เพราะ admin token เป็น internal session token ของแอป ไม่ใช่ key ที่ผู้ใช้ตั้งเอง ห้ามพยายาม copy หรือเอาไปใส่ tunnel-client

### Tunnel มีใน Platform แต่ไม่เห็นใน ChatGPT

ตรวจ workspace association, connector operator permission, tunnel ID และ `/readyz`; tunnel ใหม่อาจต้องรอ propagation

### ChatGPT เห็น tool เก่า

ใช้ **Doctor → Restart Agent Host**, ตรวจ health แล้ว refresh/reconnect connector จากนั้นทดสอบ `workspace_list` ใหม่

## 14. กฎความปลอดภัยสำหรับทีม

- ใช้ Runtime API key แยกต่อคน/ต่อเครื่อง และให้สิทธิ์น้อยที่สุด
- ห้ามแชร์ Runtime API key หรือ `OPENAI_ADMIN_KEY`
- ห้าม expose `127.0.0.1:43123` ออก Internet
- เริ่มด้วย read-only calls และตรวจ path ทุกครั้งที่มี capability-grant approval
- Codex BEG ไม่มี raw shell, generic process start, filesystem delete หรือ destructive Git reset/clean tool
- หากสงสัยว่า key รั่ว ให้ revoke/rotate ที่ Platform ทันที แล้วสร้าง key ใหม่
