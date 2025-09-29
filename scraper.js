// scraper.js
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');
const logger = require('./logger');

async function fetchHtml(url, opts = {}) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: '/usr/bin/chromium-browser', // server
            // executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // local
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        await page.setUserAgent(
            opts.userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36'
        );

        // Step 1: Visit main site to set cookies
        await page.goto('https://www.mandarake.co.jp/', { waitUntil: 'networkidle2' });

        // Step 2: Visit order site with language
        await page.goto('https://order.mandarake.co.jp/order/?lang=en', { waitUntil: 'networkidle2' });

        // Step 3: Normalize URL → add lang=en if missing
        let itemUrl = url;
        try {
            const u = new URL(url);
            if (!u.searchParams.has('lang')) {
                u.searchParams.set('lang', 'en');
                itemUrl = u.toString();
            }
        } catch (err) {
            logger.warn(`Invalid URL provided: ${url}`);
        }

        // Visit the item page
        await page.goto(itemUrl, { waitUntil: 'networkidle2' });

        // Wait for main button or sold-out div to appear
        await page.waitForSelector('.addcart, .soldout', { timeout: 5000 });

        return await page.content();
    } catch (err) {
        logger.error(`fetchHtml error for ${url}: ${err.message}`);
        throw err;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (closeErr) {
                logger.warn('Browser close failed:', closeErr.message);
            }
        }
    }
}

/**
 * Check Mandarake product page for stock:
 * - main button (id=cartButton) with text カートに入れる or class addcart
 * - other stores in section .other_itemlist .block checking .addcart / .soldout
 *
 * Returns:
 *  {
 *    url,
 *    isInStock,
 *    isInMainInStock,
 *    sameItemInOtherStores: [{ shop, price, hasAdd, soldOut, isDefective }],
 *    itemName,
 *    parentShopName
 *  }
 */
async function checkMandarake(url, opts = {}) {
    const html = await fetchHtml(url, opts);
    const $ = cheerio.load(html);

    const isInMainInStock = $('#mypagelist_form .addcart').length > 0;
    const parentShopName = $('.content_head .shop p').text().trim();
    const itemName = $('.content_head .subject h1').text().trim();

    // Parse other item lists
    const sameItemInOtherStores = [];
    const otherItemsEls = $('.other_item');

    otherItemsEls.each((sectionIndex, sectionEl) => {
        const $section = $(sectionEl);
        const heading = $section.find('h3').first().text().trim().toLowerCase();

        const isDefective =
            heading.includes('different condition') ||
            heading.includes('defective') ||
            heading.includes('diff');

        $section.find('.block').each((i, el) => {
            const block = $(el);
            const shop = block.find('.shop p').text().trim();
            const price = block.find('.price').text().trim();
            const hasAdd = block.find('.addcart').length > 0;
            const soldOut = block.find('.soldout').length > 0;

            sameItemInOtherStores.push({ shop, price, hasAdd, soldOut, isDefective });
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
