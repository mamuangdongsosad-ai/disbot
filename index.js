require('dotenv').config({ path: require('path').join(__dirname, '.env') });
'dotenv'.config({ path: require('path').join(__dirname, '.env')});
// ==========================================
// [ 1. Global Error Handlers ]
// ==========================================
process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled Rejection:', reason); });
process.on('uncaughtException',  (err)    => { console.error('💥 Uncaught Exception:',  err);    });

// ==========================================
// [ 2. Imports ]
// ==========================================
const {
    Client, GatewayIntentBits, Options, ActionRowBuilder, EmbedBuilder,
    PermissionFlagsBits, ButtonBuilder, ButtonStyle
} = require('discord.js');

const fs    = require('fs');
const axios = require('axios');

// ==========================================
// [ 3. Config / Constants ]
// ==========================================
// ⚠️ แก้ไอดีเหล่านี้ให้ตรงกับเซิร์ฟเวอร์ของคุณก่อนรันบอท
const ADMIN_ROLE_ID          = '1555146265958944878'; // Role แอดมินที่รับตั๋ว/สร้าง QR ได้
const TICKET_CATEGORY_ID     = '1554881839422906495'; // Category สำหรับสร้างห้องตั๋ว
const DONE_CATEGORY_ID       = '1554881839745994884'; // Category ที่ย้ายห้องไปเก็บหลังปิดตั๋ว
const REVIEW_CHANNEL_ID      = '1554881839745994883'; // ห้องรีวิว (เอาไว้นับจำนวน)
const SLIP_NOTIFY_CHANNEL_ID = '1555145911879864380'; // ห้องแจ้งเตือนเมื่อตรวจสอบสลิปผ่านแล้ว

const PROMPTPAY_NUMBER = '0621473585'; // เบอร์พร้อมเพย์รับเงิน
const EASYSLIP_API_KEY = process.env.EASYSLIP_API_KEY; // ⚠️ สมัครขอคีย์ที่ document.easyslip.com แล้วใส่ในไฟล์ .env

const QUEUE_FILE        = './queue.txt';
const TICKET_FILE       = './active_tickets.json';
const REVIEW_COUNT_FILE = './review_count.json';

// ==========================================
// [ 4. Runtime State ]
// ==========================================
let activeTicketData = {}; // activeTicketData[channelId] = { category, label, price, userId, qNum, payMethod, slipReceived, slipVerified, slipInfo }
let queueCount         = 1;
let reviewCount         = 0;

// ==========================================
// [ 5. Helpers ]
// ==========================================
function loadJSON(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`❌ โหลดไฟล์ ${filePath} ไม่ได้`, err);
        return fallback;
    }
}

function loadPersistentData() {
    activeTicketData = loadJSON(TICKET_FILE, {});
    if (fs.existsSync(QUEUE_FILE)) queueCount = parseInt(fs.readFileSync(QUEUE_FILE, 'utf8')) || 1;

    const reviewFile = loadJSON(REVIEW_COUNT_FILE, null);
    if (reviewFile && typeof reviewFile.count === 'number') reviewCount = reviewFile.count;
}

function saveTickets()     { fs.writeFileSync(TICKET_FILE, JSON.stringify(activeTicketData, null, 2)); }
function saveQueue()       { fs.writeFileSync(QUEUE_FILE, queueCount.toString()); }
function saveReviewCount() { fs.writeFileSync(REVIEW_COUNT_FILE, JSON.stringify({ count: reviewCount })); }

loadPersistentData();

/** ลิงก์รูป QR Code พร้อมเพย์ตามยอดเงิน (PromptPay.io) */
function buildQrUrl(amount) {
    return `https://promptpay.io/${PROMPTPAY_NUMBER}/${amount}.png`;
}

/**
 * แปลง mention ห้อง (<#id>), ไอดีห้องดิบๆ, หรือลิงก์ห้อง Discord ให้เป็นไอดีห้อง
 * รองรับ: <#123> / 123 / https://discord.com/channels/guildId/123/messageId
 */
function resolveChannelId(input) {
    if (!input) return null;
    const mention = input.match(/^<#(\d+)>$/);
    if (mention) return mention[1];
    const link = input.match(/discord\.com\/channels\/\d+\/(\d+)/);
    if (link) return link[1];
    if (/^\d+$/.test(input)) return input;
    return null;
}

/**
 * ตรวจสอบสลิปโอนเงินจริงผ่าน EasySlip API (https://document.easyslip.com)
 * ใช้ endpoint ต่างกันตามช่องทางจ่าย: ธนาคาร/พร้อมเพย์ ใช้ /verify/bank, TrueMoney ใช้ /verify/truewallet
 * @returns {Promise<{ok:boolean, reason:string, data?:object}>}
 */
async function verifySlip(imageUrl, expectedAmount, method = 'promptpay') {
    if (!EASYSLIP_API_KEY) {
        return { ok: false, reason: 'NO_API_KEY' };
    }

    const endpoint = method === 'truemoney'
        ? 'https://api.easyslip.com/v2/verify/truewallet'
        : 'https://api.easyslip.com/v2/verify/bank';

    try {
        const res = await axios.post(
            endpoint,
            {
                url: imageUrl,
                matchAmount: expectedAmount > 0 ? expectedAmount : undefined,
                checkDuplicate: true
            },
            { headers: { Authorization: `Bearer ${EASYSLIP_API_KEY}` } }
        );

        const body = res.data;
        if (!body.success) {
            return { ok: false, reason: body.error?.code || 'UNKNOWN_ERROR' };
        }

        const slip = body.data;
        if (slip.isDuplicate) {
            return { ok: false, reason: 'DUPLICATE_SLIP', data: slip };
        }
        if (expectedAmount > 0 && slip.isAmountMatched === false) {
            return { ok: false, reason: 'AMOUNT_MISMATCH', data: slip };
        }

        return { ok: true, reason: 'VERIFIED', data: slip };
    } catch (err) {
        const code = err.response?.data?.error?.code;
        if (code) return { ok: false, reason: code };
        console.error('❌ EasySlip API Error:', err.message);
        return { ok: false, reason: 'NETWORK_ERROR' };
    }
}

/** แปลงรหัสข้อผิดพลาดของ EasySlip เป็นข้อความภาษาไทยที่เข้าใจง่าย */
function slipErrorMessage(reason) {
    const map = {
        NO_API_KEY:       'ยังไม่ได้ตั้งค่าระบบตรวจสลิปอัตโนมัติ (EASYSLIP_API_KEY) — รอแอดมินตรวจสอบด้วยตนเองนะครับ',
        SLIP_NOT_FOUND:   'ไม่พบ QR Code ในรูปภาพ กรุณาส่งรูปสลิปที่เห็น QR ชัดเจนอีกครั้ง',
        SLIP_PENDING:     'สลิปธนาคารกรุงเทพยังไม่เข้าระบบ กรุณารอสักครู่แล้วส่งใหม่อีกครั้ง',
        INVALID_IMAGE_FORMAT: 'ไฟล์ที่ส่งมาไม่ใช่รูปภาพที่ถูกต้อง กรุณาส่งใหม่เป็นไฟล์ JPG/PNG',
        IMAGE_SIZE_TOO_LARGE: 'ไฟล์รูปใหญ่เกินไป (เกิน 4MB) กรุณาส่งรูปที่มีขนาดเล็กลง',
        DUPLICATE_SLIP:   'สลิปนี้เคยถูกใช้ยืนยันการชำระเงินไปแล้ว ไม่สามารถใช้ซ้ำได้ กรุณาติดต่อแอดมิน',
        AMOUNT_MISMATCH:  'ยอดเงินในสลิปไม่ตรงกับยอดที่ต้องชำระ กรุณาตรวจสอบและโอนให้ครบ หรือแจ้งแอดมิน',
        NETWORK_ERROR:    'ระบบตรวจสลิปขัดข้องชั่วคราว รอแอดมินตรวจสอบด้วยตนเองนะครับ'
    };
    return map[reason] || 'ตรวจสอบสลิปไม่สำเร็จ กรุณาลองส่งใหม่อีกครั้ง หรือรอแอดมินตรวจสอบด้วยตนเอง';
}

/** แทนที่/เติมเลขรีวิวในชื่อห้อง รูปแบบ 〔1074〕 — ไม่แตะข้อความอื่นในชื่อห้อง */
function buildReviewChannelName(currentName, count) {
    if (/〔\d+〕/.test(currentName)) {
        return currentName.replace(/〔\d+〕/, `〔${count}〕`);
    }
    return `${currentName}〔${count}〕`;
}

async function closeTicket(channelId, userId) {
    const chan = client.channels.cache.get(channelId);
    if (!chan) return;
    await chan.setParent(DONE_CATEGORY_ID, { lockPermissions: false }).catch(() => {});
    if (userId) await chan.permissionOverwrites.edit(userId, { ViewChannel: false }).catch(() => {});
    delete activeTicketData[channelId];
    saveTickets();
}

// ==========================================
// [ 6. Client ]
// ==========================================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 25
    })
});

// ==========================================
// [ 7. Message Handler: คำสั่งแอดมิน + ตรวจจับสลิป + นับรีวิว ]
// ==========================================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    // ── คำสั่งแอดมิน (เช็คก่อนเสมอ แม้จะพิมพ์ในห้องตั๋วก็ใช้ได้) ──────
    if (message.content.startsWith('!')) {
        const args    = message.content.trim().split(/ +/);
        const command = args[0].toLowerCase();

        const ADMIN_COMMANDS = ['!setupshop', '!qr'];
        if (!ADMIN_COMMANDS.includes(command)) return;

        // แจ้งเตือนชัดเจนแทนการเงียบ เผื่อ role ไม่ตรง จะได้รู้ทันทีว่าปัญหาคืออะไร
        if (!message.member || !message.member.roles.cache.has(ADMIN_ROLE_ID)) {
            return message.reply(`❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ครับ (ต้องมี role ไอดี \`${ADMIN_ROLE_ID}\`)`);
        }

        // !setupshop → โพสต์ปุ่มเปิดตั๋ว
        if (command === '!setupshop') {
            const embed = new EmbedBuilder()
                .setAuthor({ name: '🛒 SHOP', iconURL: client.user.displayAvatarURL() })
                .setTitle('🛍️ ยินดีต้อนรับสู่ร้านค้า')
                .setDescription(
`╭━━━━━━━━━━━━━━━━━━━━━━╮
✨ **กดปุ่มด้านล่างเพื่อเปิดตั๋วได้เลยครับ**
╰━━━━━━━━━━━━━━━━━━━━━━╯

🎫 แอดมินเป็นกันเองพร้อมให้บริการค้าบบ`
                )
                .setColor('#00B2FF')
                .setFooter({ text: 'ระบบร้านค้าอัตโนมัติ' });

            const buttons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('create_ticket').setLabel('ᴄʀᴇᴀᴛᴇ ᴛɪᴄᴋᴇᴛ').setEmoji('🎫').setStyle(ButtonStyle.Success)
            );

            return message.channel.send({ embeds: [embed], components: [buttons] });
        }

        // !qr [ยอดเงิน] [ห้องปลายทาง]  → สร้าง QR พร้อมเพย์ยอดที่ระบุ ส่งไปห้องไหนก็ได้
        if (command === '!qr') {
            const amount   = parseFloat(args[1]);
            const targetId = resolveChannelId(args[2]);

            if (isNaN(amount) || amount <= 0)
                return message.reply('❌ รูปแบบไม่ถูกต้อง\nรูปแบบ: `!qr [ยอดเงิน] [ห้องปลายทาง]`\nห้องปลายทางใช้ mention ห้อง (#ชื่อห้อง), ไอดีห้อง, หรือลิงก์ห้องก็ได้\nตัวอย่าง: `!qr 150 #ticket-3`');

            if (!targetId)
                return message.reply('❌ ระบุห้องปลายทางไม่ถูกต้อง ใช้การ mention ห้อง (#ชื่อห้อง), ไอดีห้อง, หรือลิงก์ห้องก็ได้ครับ');

            const targetChannel = message.guild.channels.cache.get(targetId);
            if (!targetChannel)
                return message.reply('❌ ไม่พบห้องปลายทางนี้ในเซิร์ฟเวอร์ครับ');

            const existing = activeTicketData[targetId];
            let qNum = existing?.qNum;
            if (!qNum) { qNum = queueCount++; saveQueue(); }

            activeTicketData[targetId] = {
                category:     existing?.category ?? 'manual',
                label:        existing?.label ?? 'ชำระเงิน',
                price:        amount,
                userId:       existing?.userId ?? null,
                qNum,
                payMethod:    'promptpay',
                slipReceived: false,
                slipVerified: false
            };
            saveTickets();

            const qrEmbed = new EmbedBuilder()
                .setTitle('🧾 แจ้งยอดชำระเงิน')
                .setColor('#2ECC71')
                .setDescription(
`💰 ยอดชำระ: **${amount.toLocaleString()} บาท**

📌 สแกน QR พร้อมเพย์ด้านล่างนี้ หรือโอนมาที่เบอร์: \`${PROMPTPAY_NUMBER}\`

📸 **เมื่อโอนเสร็จแล้ว ให้ส่งรูปสลิปลงในห้องนี้ได้เลยครับ!**`
                )
                .setImage(buildQrUrl(amount))
                .setFooter({ text: 'เมื่อส่งสลิปแล้ว บอทจะตรวจสอบและตอบกลับอัตโนมัติ' });

            await targetChannel.send({ embeds: [qrEmbed] });
            return message.reply(`✅ สร้าง QR ยอด **${amount.toLocaleString()} บาท** ส่งไปที่ ${targetChannel} แล้วครับ`);
        }

        return;
    }

    // ── ระบบนับรีวิว ─────────────────────────────────────────────
    if (message.channel.id === REVIEW_CHANNEL_ID) {
        const isAdmin = message.member?.roles.cache.has(ADMIN_ROLE_ID);
        if (!isAdmin) {
            reviewCount++;
            saveReviewCount();

            const newName = buildReviewChannelName(message.channel.name, reviewCount);
            if (newName !== message.channel.name) {
                await message.channel.setName(newName).catch(err => {
                    console.error('⚠️ เปลี่ยนชื่อห้องรีวิวไม่ได้ (อาจติด rate limit ของ Discord):', err.message);
                });
            }
        }
        return;
    }

    // ── ตรวจจับ + ตรวจสอบสลิปอัตโนมัติ (ห้องไหนก็ได้ที่มีการแจ้งยอดด้วย !qr หรือเป็นห้องตั๋ว) ──
    const ticketData = activeTicketData[message.channel.id];
    if (ticketData) {
        const isAdmin = message.member.roles.cache.has(ADMIN_ROLE_ID);
        const image   = message.attachments.find(a => (a.contentType || '').startsWith('image/'));

        if (ticketData.price > 0 && !isAdmin && image && !ticketData.slipVerified) {
            const checkingMsg = await message.reply('🔍 กำลังตรวจสอบสลิป กรุณารอสักครู่นะครับ...');

            const result = await verifySlip(image.url, ticketData.price, ticketData.payMethod);

            if (result.ok) {
                ticketData.slipVerified = true;
                ticketData.slipReceived = true;
                ticketData.slipInfo = {
                    transRef: result.data.rawSlip?.transRef ?? '-',
                    amount:   result.data.rawSlip?.amount?.amount ?? ticketData.price,
                    sender:   result.data.rawSlip?.sender?.account?.name?.th ?? 'ไม่ทราบชื่อ'
                };
                saveTickets();

                const verifiedEmbed = new EmbedBuilder()
                    .setColor('#2ECC71')
                    .setTitle('✅ ตรวจสอบสลิปสำเร็จ — รับยอดครับ')
                    .addFields(
                        { name: '👤 ผู้โอน',    value: ticketData.slipInfo.sender, inline: true },
                        { name: '💰 ยอดโอน',    value: `${ticketData.slipInfo.amount.toLocaleString()} บาท`, inline: true },
                        { name: '🔖 เลขอ้างอิง', value: `\`${ticketData.slipInfo.transRef}\``, inline: false }
                    )
                    .setFooter({ text: 'ตรวจสอบผ่าน EasySlip • รอแอดมินดำเนินการต่อ' });

                await checkingMsg.edit({ content: null, embeds: [verifiedEmbed] });
                await message.channel.send(`🔔 <@&${ADMIN_ROLE_ID}> ลูกค้าโอนเงินแล้ว **ตรวจสอบสลิปผ่าน ✅** (คิวที่ ${ticketData.qNum})`);

                // แจ้งเตือนที่ห้องแจ้งสลิปกลาง
                const notifyChannel = client.channels.cache.get(SLIP_NOTIFY_CHANNEL_ID);
                if (notifyChannel) {
                    await notifyChannel.send({
                        embeds: [new EmbedBuilder()
                            .setColor('#2ECC71')
                            .setTitle('✅ มีการชำระเงิน — ตรวจสอบสลิปผ่านแล้ว')
                            .addFields(
                                { name: '👤 ลูกค้า',    value: ticketData.userId ? `<@${ticketData.userId}>` : 'ไม่ทราบ', inline: true },
                                { name: '💰 ยอดโอน',    value: `${ticketData.slipInfo.amount.toLocaleString()} บาท`, inline: true },
                                { name: '🔖 เลขอ้างอิง', value: `\`${ticketData.slipInfo.transRef}\``, inline: false },
                                { name: '📍 ห้องออเดอร์', value: `<#${message.channel.id}>`, inline: false }
                            )]
                    }).catch(() => {});
                }
            } else {
                // สลิปยังไม่ผ่าน — ไม่ mark ว่ารับยอดแล้ว ให้ลูกค้าส่งใหม่ได้
                await checkingMsg.edit({ content: `❌ ${slipErrorMessage(result.reason)}` });

                // กรณีระบบขัดข้อง/ไม่ได้ตั้งค่าคีย์ ให้แจ้งแอดมินมาตรวจเองแทน จะได้ไม่ตกหล่น
                if (['NO_API_KEY', 'NETWORK_ERROR'].includes(result.reason) && !ticketData.slipReceived) {
                    ticketData.slipReceived = true;
                    saveTickets();
                    await message.channel.send(`🔔 <@&${ADMIN_ROLE_ID}> ลูกค้าส่งสลิปมาแต่ระบบตรวจอัตโนมัติใช้งานไม่ได้ กรุณาตรวจสอบด้วยตนเองครับ (คิวที่ ${ticketData.qNum})`);
                }
            }
        }
    }
});

// ════════════════════════════════════════════════════════════
//  TICKET FLOW
//
//  create_ticket → สร้างห้องตั๋วทันที ไม่ถามอะไรเลย
//  แอดมินใช้ !qr [ยอด] [ห้อง] เพื่อแจ้งยอด+สร้าง QR เมื่อไหร่ก็ได้ ห้องไหนก็ได้
//  ADMIN: btn_work (รับงาน)  |  btn_done (ปิดห้อง — แอดมินหรือเจ้าของตั๋วกดได้)
// ════════════════════════════════════════════════════════════

client.on('interactionCreate', async (interaction) => {
    try {
        // ─────────────────────────────────────────────────────────
        //  create_ticket → สร้างห้องตั๋วทันที
        // ─────────────────────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === 'create_ticket') {
            await interaction.deferReply({ ephemeral: true });

            const channel = await interaction.guild.channels.create({
                name:   `ticket-${queueCount}`,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny:  [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
                    { id: ADMIN_ROLE_ID,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });

            activeTicketData[channel.id] = {
                category:     'ticket',
                label:        'Ticket',
                price:        0,
                userId:       interaction.user.id,
                qNum:         queueCount,
                payMethod:    'promptpay',
                slipReceived: false,
                slipVerified: false
            };
            saveTickets();

            const embed = new EmbedBuilder()
                .setTitle(`🎫 Ticket #${queueCount}`)
                .setColor('#5865F2')
                .setDescription(`สวัสดีครับ <@${interaction.user.id}>\n\nแจ้งรายละเอียดที่ต้องการได้เลยครับ รอแอดมินเข้ามาดำเนินการและแจ้งยอดชำระให้สักครู่นะครับ`);

            const btns = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_work').setLabel('รับงาน').setEmoji('🎀').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('btn_done').setLabel('ปิดห้อง').setEmoji('🧸').setStyle(ButtonStyle.Success)
            );

            await channel.send({ content: `🔔 <@&${ADMIN_ROLE_ID}>`, embeds: [embed], components: [btns] });

            queueCount++;
            saveQueue();

            return interaction.editReply({ content: `✅ สร้างตั๋วเรียบร้อยแล้ว! แตะที่นี่ได้เลย 👉 ${channel}` });
        }

        // ════════════════════════════════════════════════════════════
        //  ADMIN TICKET BUTTONS
        // ════════════════════════════════════════════════════════════

        if (interaction.isButton() && interaction.customId === 'btn_work') {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return;
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            await interaction.reply({ content: `👨‍💻 <@${interaction.user.id}> รับงานนี้แล้วครับ กำลังดำเนินการให้${data.userId ? ` <@${data.userId}>` : ''}` });
            return interaction.channel.setName(`🛠️-${data.qNum}`).catch(() => {});
        }

        if (interaction.isButton() && interaction.customId === 'btn_done') {
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            const isAdmin = interaction.member.roles.cache.has(ADMIN_ROLE_ID);
            if (!isAdmin && interaction.user.id !== data.userId)
                return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ปิดห้องนี้ครับ', ephemeral: true });

            const embed = new EmbedBuilder()
                .setColor('#773805').setTitle('✅ ปิดห้องแล้ว')
                .setDescription(`ห้องนี้ถูกปิดแล้วครับ\n\n💖 ขอบคุณที่ใช้บริการครับ ฝากรีวิวได้ที่ <#${REVIEW_CHANNEL_ID}>`);

            await interaction.message.edit({ components: [] }).catch(() => {});
            await interaction.reply({ embeds: [embed] });
            await interaction.channel.setName(`✅-${data.qNum}`).catch(() => {});

            setTimeout(() => closeTicket(interaction.channel.id, data.userId), 15 * 60 * 1000);
            return;
        }

    } catch (err) {
        console.error('❌ Error:', err);
        try {
            if (interaction && !interaction.replied && !interaction.deferred)
                await interaction.reply({ content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', ephemeral: true });
            else if (interaction && interaction.deferred)
                await interaction.followUp({ content: '❌ เกิดข้อผิดพลาดในการประมวลผล', ephemeral: true });
        } catch (_) {}
    }
});

// ==========================================
// [ 8. Login ]
// ==========================================
// ⚠️ ห้ามเขียนโทเคนตรงๆ ในโค้ด — ใส่ไว้ในไฟล์ .env เป็น TOKEN=your_token_here
client.login(process.env.DISCORD_TOKEN);
