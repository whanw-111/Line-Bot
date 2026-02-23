const line = require("@line/bot-sdk");
const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const moment = require("moment");
const cron = require("node-cron");

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_LINE_ID = process.env.ADMIN_LINE_ID;
const LINE_AT_ID = "@534fnmlm"; // แก้เป็น ID แอดมินของพี่

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY
    ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const client = new line.Client(config);
const app = express();
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// ฟังก์ชันบันทึกสมาชิกใหม่
async function saveNewMember(userId, displayName, groupId) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const joinDate = moment().format("YYYY-MM-DD");
    await sheet.addRow({
      "User ID": userId,
      "Display Name": displayName,
      "Join Date": joinDate,
      Status: "Active",
      "Group ID": groupId,
    });
    console.log(`✅ บันทึกสำเร็จ: ${displayName}`);
  } catch (err) {
    console.error("❌ Save Error:", err.message);
  }
}

// ระบบตรวจสอบอายุสมาชิก (แจ้งเตือนวันที่ 27-30)
cron.schedule("0 9 * * *", async () => {
  console.log("🏃 กำลังตรวจสอบรายชื่อสมาชิก...");
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const today = moment();

    for (let row of rows) {
      if (row.get("Status") === "Active") {
        const joinDate = moment(row.get("Join Date"));
        const daysDiff = today.diff(joinDate, "days");
        const uId = row.get("User ID");
        const uName = row.get("Display Name");
        const gId = row.get("Group ID");

        if (daysDiff >= 27 && daysDiff < 30) {
          const remainDays = 30 - daysDiff;
          const msg = `📢 แจ้งเตือนคุณ ${uName}\nอีก ${remainDays} วันสมาชิกจะหมดอายุครับ! อย่าลืมต่ออายุนะครับ`;
          try {
            await client.pushMessage(uId, { type: "text", text: msg });
          } catch (e) {}
          if (gId) {
            try {
              await client.pushMessage(gId, {
                type: "text",
                text: `🔔 ${uName} เหลือเวลาสมาชิกอีก ${remainDays} วันครับ`,
              });
            } catch (e) {}
          }
          await client.pushMessage(ADMIN_LINE_ID, {
            type: "text",
            text: `[ใกล้หมดอายุ] ${uName} (เหลือ ${remainDays} วัน)`,
          });
        }

        if (daysDiff >= 30) {
          const expireMsg = `🚫 หมดเวลาสมาชิกแล้วครับคุณ ${uName}\nขอบคุณที่อยู่ด้วยกันนะครับ`;
          try {
            await client.pushMessage(uId, { type: "text", text: expireMsg });
          } catch (e) {}
          if (gId) {
            try {
              await client.pushMessage(gId, {
                type: "text",
                text: `🚫 คุณ ${uName} หมดอายุสมาชิกแล้วครับ`,
              });
            } catch (e) {}
          }
          await client.pushMessage(ADMIN_LINE_ID, {
            type: "text",
            text: `🚨 [หมดอายุ] กรุณาเตะออก 🚨\n👤 ชื่อ: ${uName}\n🆔 ID: ${uId}\n(ระบบลบข้อมูลใน Sheet แล้ว)`,
          });
          await row.delete();
          console.log(`🗑 ลบข้อมูล ${uName} เรียบร้อย`);
        }
      }
    }
  } catch (err) {
    console.error("❌ Cron Error:", err);
  }
});

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then((result) =>
    res.json(result),
  );
});

async function handleEvent(event) {
  const userId = event.source.userId;
  const groupId = event.source.groupId;

  // --- ส่วนที่ปรับปรุง: ต้อนรับทุกคนและบันทึกลง Sheet ทันที ---
  if (event.type === "memberJoined") {
    for (let member of event.joined.members) {
      try {
        const profile = await client.getGroupMemberProfile(
          groupId,
          member.userId,
        );

        // 1. บันทึกสมาชิกใหม่ลงหน้าแรก (ชีต1)
        await saveNewMember(member.userId, profile.displayName, groupId);

        // 2. ดึงรูปจากหน้าแรก (ช่อง F1 และ G1)
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        await sheet.loadCells("F1:G1"); // โหลดรวดเดียว 2 ช่อง

        const imgLink1 = sheet.getCellByA1("F1").value
          ? sheet.getCellByA1("F1").value.toString().trim()
          : "";
        const imgLink2 = sheet.getCellByA1("G1").value
          ? sheet.getCellByA1("G1").value.toString().trim()
          : "";

        const messages = [];

        // เช็คและเพิ่มรูปที่ 1
        if (imgLink1 && imgLink1.startsWith("http")) {
          messages.push({
            type: "image",
            originalContentUrl: imgLink1,
            previewImageUrl: imgLink1,
          });
        }

        // เช็คและเพิ่มรูปที่ 2 (รูปใหม่ที่พี่ต้องการ)
        if (imgLink2 && imgLink2.startsWith("http")) {
          messages.push({
            type: "image",
            originalContentUrl: imgLink2,
            previewImageUrl: imgLink2,
          });
        }

        // 3. ส่งข้อความต้อนรับปิดท้าย
        messages.push({
          type: "text",
          text: `!ยินดีต้อนรับพี่ ${profile.displayName}!เข้ากลุ่มลับหนูนะคะ 💕

          พี่ๆสามารถเข้าดูคลิปรีรันได้ที่โน้ตกลุ่มได้เลยน้า
          มีวิธีดาวน์โหลดแอพBAND ไว้ดูไลฟ์สดหนูนะคะสามารถพิมคุยกันได้ด้วยค่ะ มีอะไรหนูจะอัพเดพให้ทางแชทกับโน้ตน้า
           อยู่กับหนูไปนานๆนะคะรักนะคะ💗`,
        });

        await client.replyMessage(event.replyToken, messages);
        console.log(
          `✅ ส่งรูปต้อนรับ 2 รูปให้คุณ ${profile.displayName} เรียบร้อย`,
        );
      } catch (err) {
        console.error("Member Join Error:", err);
      }
    }
  }

  if (event.type === "join") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `สวัสดีครับ! บอทจัดการสมาชิกพร้อมทำงานที่กลุ่มนี้แล้ว\n🆔 ID กลุ่ม: ${groupId}`,
    });
  }

  if (event.type === "message" && event.message.type === "text") {
    const userMsg = event.message.text;

    if (userMsg === "สนใจ" || userMsg === "ช่องทางชำระเงิน") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขอบคุณที่สนใจครับพี่! กลุ่มของเรามีสาวๆ ไลฟ์สดให้ดูทุกวัน\nสมัครวันนี้ดูได้ทันทีครับ\n🏦 ช่องทางโอนเงิน\nธนาคาร: กสิกรไทย\nเลขบัญชี: xxx-x-xxxxx-x\nชื่อบัญชี: xxxxxxxx\n\nโอนแล้วส่งสลิปไว้ได้เลยค่ะ",
      });
    } else if (userMsg === "ติดต่อแอดมิด") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `ทักหาแอดมินได้เลยที่นี่ค่ะ: ${LINE_AT_ID}\nหรือรอสักครู่ เดี๋ยวแอดมินทักกลับไปค่ะ`,
      });
    } else {
      if (userId === ADMIN_LINE_ID) return null;
      let name = "สมาชิก";
      try {
        if (groupId) {
          const p = await client.getGroupMemberProfile(groupId, userId);
          name = p.displayName;
        }
      } catch (e) {}

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `ทักแอดมินน่ะค่ะ line ของแอดมิน: ${LINE_AT_ID}`,
      });
      await client.pushMessage(ADMIN_LINE_ID, {
        type: "text",
        text: `📢 มีคนทัก!\n👤 ชื่อ: ${name}\n💬: ${userMsg}`,
      });
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ระบบพร้อมทำงานที่พอร์ต ${PORT}`);
});
