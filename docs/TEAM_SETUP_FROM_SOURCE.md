# Codex BEG — setup from GitHub checkout

ใช้เอกสารนี้เมื่อทีมต้อง clone repository แล้ว build/install เองบน macOS Apple Silicon

## 1. Clone และติดตั้งทุกอย่างบนเครื่อง clean

```bash
git clone https://github.com/newchille/codex-beg.git gpt-mcp
cd gpt-mcp
./scripts/bootstrap-macos.sh
```

`bootstrap-macos.sh` จะทำให้ครบในครั้งเดียว:

- ตรวจว่าเป็น macOS Apple Silicon
- ติดตั้ง Homebrew ถ้ายังไม่มี
- ติดตั้ง Node.js และ pnpm
- build/install และเปิด `Codex BEG.app`
- ติดตั้ง official `tunnel-client`
- ถามและบันทึก `tunnel_id` กับ Runtime API key แบบปลอดภัยครั้งแรก

ทุกครั้งที่รัน `bootstrap-macos.sh` จะ build แอปใหม่จาก source ปัจจุบัน ลบ build output เดิมและลบแอปที่ติดตั้งอยู่ก่อน แล้วติดตั้งตัวใหม่ โดยไม่เก็บ backup

ถ้าต้องการติดตั้งทุกอย่างแต่ยังไม่เชื่อม tunnel ให้ใช้ `--skip-connect` แล้วค่อยรัน `./scripts/run-codex-beg.sh` ภายหลัง

เปิดแอปแล้วไปที่ **Doctor → Run checks** ต้องเห็น Agent Host running และ endpoint เป็น `http://127.0.0.1:43123/mcp`

## 2. ติดตั้ง tunnel-client แยก (กรณีไม่ได้ใช้ bootstrap)

```bash
./scripts/setup-tunnel-client.sh
```

ถ้าจะให้ Codex CLI ช่วยจัดการ tunnel ด้วย ให้ติดตั้ง official Tunnel MCP plugin เพิ่ม:

```bash
./scripts/setup-tunnel-client.sh --with-codex-plugin
```

Tunnel MCP plugin สำหรับ Codex CLI เป็น optional; การสร้าง ChatGPT MCP app ทำบนเว็บตามข้อ 4

## 3. บันทึกค่าต่อเครื่องครั้งเดียว

ผู้ดูแล Platform ต้องเตรียม tunnel และ Runtime API key ให้ผู้ใช้แต่ละคน/แต่ละเครื่อง โดย key ต้องมี Tunnels **Read + Use** เท่านั้น

หลังติดตั้งครั้งแรก ให้รันคำสั่งนี้เพื่อบันทึกค่า:

```bash
./scripts/configure-codex-beg.sh
```

สคริปต์จะถาม `tunnel_id` และ Runtime API key แบบไม่แสดงบนจอ แล้วบันทึกไว้ที่:

- `~/.config/codex-beg/tunnel-id`
- `~/.config/codex-beg/secrets/control-plane-api-key` (mode `600`)

ไม่ต้องใส่ API key ใน `~/.zshrc`, Git หรือ command argument

ถ้าต้องการเปลี่ยน tunnel หรือหมุน API key:

```bash
./scripts/configure-codex-beg.sh --force
```

## 4. รันครั้งถัดไปโดยไม่ติดตั้งและไม่ถามค่า

```bash
./scripts/run-codex-beg.sh
```

สคริปต์จะเปิดแอป รอ Agent Host healthy แล้วโหลดค่าที่บันทึกไว้เพื่อเชื่อม tunnel โดยไม่ติดตั้งอะไรใหม่

ถ้าต้องการใช้ environment variable หรือ key file สำหรับ automation ก็ยังใช้รูปแบบเดิมได้:

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
printf 'Runtime API key (input hidden): '
IFS= read -r -s CONTROL_PLANE_API_KEY
printf '\n'
export CONTROL_PLANE_API_KEY
./scripts/run-tunnel-client.sh
unset CONTROL_PLANE_API_KEY
```

ห้ามใส่ key ลงใน Git, command argument, chat หรือ screenshot

สคริปต์จะตรวจ local health, เรียก `tunnel-client runtimes connect`, แล้วตรวจ `runtimes status --json` ต่อทันที โดยไม่พิมพ์ API key ออกมา

## 5. สร้าง MCP app/plugin ใน ChatGPT

1. คง Codex BEG และ managed tunnel runtime ให้ `healthy`/`ready`
2. เปิด [ChatGPT Plugins](https://chatgpt.com/plugins) บนเว็บ
3. กด `+` เพื่อสร้าง developer-mode app (บาง workspace อาจแสดงชื่อ **Apps → Create**)
4. เลือก **Tunnel** ในช่อง Connection
5. เลือก tunnel ที่แสดง หรือ paste `tunnel_id` เดียวกับเครื่องนี้
6. กรอก metadata ของ app, กด **Scan Tools** แล้วกด **Create**
7. เปิดแชตใหม่ แล้วเลือก draft app จากเมนู Tools เพื่อทดสอบ

ถ้าไม่เห็นปุ่มสร้าง app หรือ developer mode ให้ workspace admin เปิดสิทธิ์ Developer mode / Create custom MCP connectors ก่อน

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

หลัง reboot ให้รัน `./scripts/run-codex-beg.sh` ใหม่ถ้า status ไม่ได้เป็น running/healthy/ready

Official references:

- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [tunnel-client end-user guide](https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md)
- [Tunnel MCP plugin](https://github.com/openai/tunnel-client/blob/master/plugins/tunnel-mcp/README.md)
