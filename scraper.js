// scraper.js
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');
const logger = require('./logger');

// Reuse browser instance
let browserInstance = null;

async function getBrowser() {
    if (!browserInstance || !browserInstance.isConnected()) {
        browserInstance = await puppeteer.launch({
            headless: true,
            executablePath: '/usr/bin/chromium-browser', // server
            //executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // local
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--no-first-run',
                '--disable-software-rasterizer', // for Pi
                '--single-process', // for Pi
            ],
        });
    }
    return browserInstance;
}

// Cache session - skip steps 1 & 2 if already established
let sessionReady = false;

async function fetchHtml(url, opts = {}) {
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        await page.setRequestInterception(true);
        page.on('request', request => {
            const type = request.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        await page.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // Only establish session once
        if (!sessionReady) {
            await page.goto('https://www.mandarake.co.jp/en/', {
                waitUntil: 'networkidle2',
                timeout: 15000
            });
            await page.goto('https://order.mandarake.co.jp/order/?lang=en', {
                waitUntil: 'networkidle0',
                timeout: 15000
            });
            sessionReady = true;
        }

        const u = new URL(url);
        u.searchParams.set('lang', 'en');

        await page.goto(u.toString(), {
            waitUntil: 'networkidle0',
            timeout: 15000
        });

        await page.waitForSelector('#mypagelist_form, .other_item, .addcart, .soldout', { timeout: 10000 });

        return await page.content();
    } catch (err) {
        sessionReady = false; // Reset on error
        logger.error(`fetchHtml error for ${url}: ${err.message}`);
        throw err;
    } finally {
        await page.close().catch(() => {});
    }
}

async function checkMandarake(url, opts = {}) {
    const html = await fetchHtml(url, opts);
    const $ = cheerio.load(html);

    const isInMainInStock = $('#mypagelist_form .addcart').length > 0;
    const parentShopName = $('.content_head .shop p').text().trim();
    const itemName = $('.content_head .subject h1').text().trim();

    // Parse other item lists


    const sameItemInOtherStores = [];

    $('.other_item').each((_, sectionEl) => {
        const $section = $(sectionEl);

        // Process each h3 + following .other_itemlist pair
        $section.find('h3').each((_, h3El) => {
            const $h3 = $(h3El);
            const heading = $h3.text().trim().toLowerCase();
            const isDefective = /different condition|defective/.test(heading);

            // Get the .other_itemlist that immediately follows this h3
            const $itemList = $h3.next('.other_itemlist');

            $itemList.find('.block').each((_, el) => {
                const block = $(el);
                sameItemInOtherStores.push({
                    shop: block.find('.shop p').text().trim(),
                    price: block.find('.price').text().trim(),
                    hasAdd: block.find('.addcart').length > 0,
                    soldOut: block.find('.soldout').length > 0,
                    isDefective
                });
            });
        });
    });


    const isInStock =
        isInMainInStock || sameItemInOtherStores.some(s => s.hasAdd && !s.soldOut);

    return {
        url,
        isInStock,
        isInMainInStock,
        sameItemInOtherStores,
        itemName,
        parentShopName,
    };
}

module.exports = { checkMandarake };
