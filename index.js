const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { CookieJar } = require("tough-cookie");
const sqlite3 = require("sqlite3").verbose();
const { zipcodes } = require("./lib/constants");
const fs = require("fs");
const path = require("path");
const { sendTelegramAlert } = require("./lib/telegram");
const { getMapImage } = require("./lib/google");

const { Cluster } = require("puppeteer-cluster");
const vanillaPuppeteer = require("puppeteer");
const { addExtra } = require("puppeteer-extra");
const Stealth = require("puppeteer-extra-plugin-stealth");

const cookieJar = new CookieJar();
const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const database = path.join(dataDir, "properties.db");

const { FILTER_PLATFORM, PUPPETEER_EXECUTABLE_PATH, NODE_ENV } = process.env;

// Initialize database
const initDatabase = async () => {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(database, (error) => {
      if (error) reject(error);
    });

    // Create table
    db.run(
      `CREATE TABLE IF NOT EXISTS properties(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT,
        url TEXT UNIQUE,
        image TEXT,
        floor TEXT,
        street TEXT,
        zipcode TEXT,
        meters INTEGER,
        price INTEGER,
        garden TEXT,
        rooftarrace TEXT,
        year INTEGER,
        rooms INTEGER,
        servicecosts INTEGER,
        rating INTEGER,
        reason TEXT
      )`,
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );

    db.close();
  });
};

async function getRow(database, sql, params) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function fetchWithCookies(url, options) {
  options = options || {};
  options.headers = options.headers || {};
  options.headers["User-Agent"] = userAgent;

  // Use `tough-cookie` to include cookies in request
  const cookies = await cookieJar.getCookieString(url);
  options.headers["Cookie"] = cookies;

  const response = await fetch(url, options);

  // Save cookies from response
  const setCookies = response.headers.raw()["set-cookie"];
  if (setCookies) {
    await Promise.all(
      setCookies.map((cookie) => cookieJar.setCookie(cookie, url))
    );
  }

  return response;
}

function emoji(likebility) {
  if (!likebility) return "";

  const emojis = {
    1: "🤬",
    2: "😡",
    3: "😠",
    4: "😞",
    5: "😐",
    6: "🙂",
    7: "😊",
    8: "😃",
    9: "😍",
    10: "🥰",
  };

  return emojis[likebility];
}

async function processResult(db, result, config, fetchFunction) {
  // Insert results into database
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO properties
    (platform, url, image, floor, street, zipcode, meters, price, garden, rooftarrace, year, rooms, servicecosts, rating, reason)
    VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (let property of result) {
    // Check if property.url is in database

    const row = await getRow(db, `SELECT * FROM properties WHERE url = ?`, [
      property.url,
    ]);

    if (row) continue;

    // Run enrichCallback if it exists
    if (config.enrichCallback) {
      try {
        property = await config.enrichCallback(property, fetchFunction);
      } catch (error) {
        console.error(error);
      }
    }

    // Get apendix of property.street, like --3 should return 3, -H should return H, etc.
    const appendix = property.street.match(/[0-9]+[- ]+([1-9]|h|hs|i+)$/i)?.[1];
    const floor =
      property.floor === "begane grond"
        ? 0
        : /^[0-9]+$/.test(property.floor)
        ? parseInt(property.floor)
        : /^[0-9]+$/.test(appendix)
        ? parseInt(appendix)
        : appendix === "h" || appendix === "hs"
        ? 0
        : /^i+$/i.test(appendix)
        ? appendix.length
        : null;

    // Check if the zipcode is in your list
    const zipcodeObj = zipcodes.find(
      (z) => z.code === parseInt(property.zipcode)
    );

    const alert = zipcodeObj && (!property.meters || property.meters >= 59);

    const useAi =
      config.getAIProperties && (alert || NODE_ENV === "development");

    let ai;

    try {
      ai = useAi ? await config.getAIProperties(fetchFunction, property) : null;
    } catch (error) {
      console.error(error);
    }

    if (alert) {
      const pricePerMeter =
        property.price && property.meters
          ? `€${Math.round(property.price / property.meters)}/m2`
          : null;

      const floorScore =
        floor === 0 && ai?.garden
          ? 10
          : ai?.rooftarrace
          ? 8
          : floor === 0 || ai?.garden
          ? 5
          : 0;

      const emojiScore = Math.round(
        (zipcodeObj?.likebility + floorScore + (ai?.rating || 10) / 10) / 3
      );

      const line = [
        emojiScore ? `${emoji(emojiScore)} ${emojiScore}/10` : null,
        `📍${zipcodeObj?.likebility}/10`,
        property.price ? `€${Math.round(property.price / 1000)}k` : "",
        property.meters ? `${property.meters}m2` : "",
        pricePerMeter,
        property.street,
        floor ? `🛗 ${floor}` : null,
        ai?.rooms ? `🛏 ${ai.rooms}` : null,
        ai?.servicecosts ? `🧾 €${ai.servicecosts} p/m` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      const lines = [
        emoji(emojiScore) >= 7 ? `🚨🚨🚨 Might be a good property!` : "",
        line,
        `[${property.url}](${property.url})`,
        ai?.reason ? `_AI rating ${ai.rating || 0}/100. ${ai.reason}_` : null,
      ];

      // Get map image from Google
      const city = property._city || "Amsterdam";
      const address = `${property.street}, ${city}, The Netherlands`;
      const imageBuffer = await getMapImage({ address });

      // Send alert to Telegram
      const disable_notification = zipcodeObj?.likebility <= 5;
      await sendTelegramAlert(
        lines.filter(Boolean).join("\n"),
        [property.image, imageBuffer],
        { disable_notification }
      );
    }

    stmt.run(
      config.platform,
      property.url,
      property.image,
      floor,
      property.street,
      property.zipcode,
      property.meters || ai?.size || null,
      property.price || ai?.price || null,
      ai?.garden || null,
      ai?.rooftarrace || null,
      ai?.year || null,
      property.rooms || ai?.rooms || null,
      ai?.servicecosts || null,
      ai?.rating || null,
      ai?.reason || null,
      function (err) {
        if (err) return console.log(err.message);
      }
    );
  }

  stmt.finalize();
}

const createCluster = async () => {
  const puppeteer = addExtra(vanillaPuppeteer);
  puppeteer.use(Stealth());

  const cluster = await Cluster.launch({
    executablePath: PUPPETEER_EXECUTABLE_PATH,
    concurrency: Cluster.CONCURRENCY_BROWSER,
    maxConcurrency: 2, // Adjust the number of concurrent browsers as needed
    puppeteer,
    puppeteerOptions: {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
        "--deterministic-fetch",
        "--disable-features=IsolateOrigins",
        "--disable-site-isolation-trials",
      ],
    },
  });

  return cluster;
};

async function main() {
  const cluster = await createCluster();

  await cluster.task(async ({ page, data = {} }) => {
    if (!data?.url || !/^https?:\/\//.test(data.url)) {
      throw new Error(`Invalid URL: ${data.url}`);
    }

    await page.goto(data.url, { waitUntil: "networkidle2", timeout: 15000 });
    return await page.content();
  });

  console.log(
    `=> ${new Date().toISOString().slice(0, 16)} Starting crawler...`
  );

  const db = new sqlite3.Database(database, (error) => {
    if (error) console.error(error);
  });

  // Get all config files
  const crawlerDir = path.join(__dirname, "crawlers");
  const files = fs.readdirSync(crawlerDir);
  const configFiles = files.filter((file) => file.endsWith(".js"));

  for (const configFile of configFiles) {
    const config = require(path.join(crawlerDir, configFile));

    // Skip other than FILTER_PLATFORM crawlers
    if (FILTER_PLATFORM && config.platform !== FILTER_PLATFORM) continue;

    if (!config.parseHTML && !config.parseJSON)
      throw new Error(
        `Config ${configFile} does not have a parseHTML or parseJSON function`
      );

    let result = [];

    if (config.puppeteer) {
      const html = await cluster.execute({ url: config.targetUrl });
      const $ = cheerio.load(html);
      result = config.parseHTML($);
    } else {
      // Fetch initial page to get PHPSESSID cookie
      if (config.baseUrl) await fetchWithCookies(config.baseUrl);

      let options = {};

      if (config.postData) {
        const token = cookieJar
          ?.getCookiesSync(config.baseUrl)
          ?.find((c) => c.key === "__RequestVerificationToken")?.value;

        options = {
          method: "POST",
          body: config.postData.replace(
            /\{\{__RequestVerificationToken\}\}/,
            token || ""
          ),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
          },
        };
      }

      const response = await fetchWithCookies(config.targetUrl, options);

      try {
        if (config.parseJSON) {
          const json = await response.json();
          result = config.parseJSON(json);
        } else {
          const body = await response.text();
          const $ = cheerio.load(body);
          result = config.parseHTML($);
        }
      } catch (error) {
        console.error(error);
      }
    }

    // Insert into database
    await processResult(
      db,
      result,
      config,
      config.puppeteer
        ? (...props) => cluster.execute(...props)
        : fetchWithCookies
    );
  }

  db.close();
}

(async () => {
  // open the database
  await initDatabase();

  // run the main function
  main().catch(console.error);

  setInterval(() => {
    main().catch(console.error);
  }, 30 * 60 * 1000); // 30 minutes in milliseconds
})();
