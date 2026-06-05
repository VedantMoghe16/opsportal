import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Config-only seed. Inserts the channel partners we operate with (editable in
 * Settings) — NO sample orders, GRNs, inventory or SKUs. Real data arrives via
 * channel ingestion (e.g. Blinkit PO dumps). Safe to re-run (upserts by domain).
 */
async function main() {
  console.log("🌱 Seeding channel configs (no sample data)…");

  const channels = [
    {
      name: "Blinkit",
      emailDomain: "blinkit.com",
      poSenderEmail: "po@blinkit.com",
      grnSenderEmail: "grn@blinkit.com",
      tier: "A",
      fillRateCommitment: 95.0,
      deliverySlaHours: 24,
      billingGstin: "06AABCB5678B1Z2",
      billingAddress: "Blinkit (Grofers India), Gurugram, Haryana 122002",
      logoColor: "#F8CB46",
      grnViaEmail: true,
    },
    {
      name: "Nykaa",
      emailDomain: "nykaa.com",
      poSenderEmail: "purchase@nykaa.com",
      grnSenderEmail: "grn@nykaa.com",
      tier: "A",
      fillRateCommitment: 92.0,
      deliverySlaHours: 48,
      billingGstin: "27AAACN1234N1Z5",
      billingAddress: "Nykaa E-Retail, Mumbai, Maharashtra 400063",
      logoColor: "#FC2779",
      grnViaEmail: true,
    },
    {
      name: "Instamart",
      emailDomain: "swiggy.com",
      poSenderEmail: "instamart-po@swiggy.com",
      grnSenderEmail: "instamart-grn@swiggy.com",
      tier: "B",
      fillRateCommitment: 85.0,
      deliverySlaHours: 48,
      billingGstin: "29AACCB1234C1Z9",
      billingAddress: "Bundl Technologies, Bengaluru, Karnataka 560103",
      logoColor: "#FC8019",
      grnViaPortal: true,
      grnViaEmail: false,
      portalUrl: "https://partner.swiggy.com/login",
      portalUsername: "ops@moxiebeauty.in",
      portalPasswordEnvVar: "INSTAMART_PORTAL_PASSWORD",
    },
  ];

  for (const c of channels) {
    await prisma.channel.upsert({
      where: { emailDomain: c.emailDomain },
      create: c,
      update: {
        name: c.name,
        tier: c.tier,
        logoColor: c.logoColor,
      },
    });
  }

  console.log(`✅ ${channels.length} channels ready. Import real POs via the channel ingestion (Blinkit).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
