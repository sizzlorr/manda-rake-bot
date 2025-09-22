// scraper.js
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

async function fetchHtml(url, opts = {}) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36'
    );
    try {
        // Step 1: Visit main site to set cookies
        await page.goto('https://www.mandarake.co.jp/', { waitUntil: 'networkidle2' });

        // Step 2: Visit order site with language
        await page.goto('https://order.mandarake.co.jp/order/?lang=en', { waitUntil: 'networkidle2' });

        // Step 3: Normalize URL → add lang=en if missing
        let itemUrl = url;
        const u = new URL(url);
        if (!u.searchParams.has('lang')) {
            u.searchParams.set('lang', 'en');
            itemUrl = u.toString();
        }

        // Visit the item page
        await page.goto(itemUrl, { waitUntil: 'networkidle2' });

        // Wait for main button or sold-out div to appear
        await page.waitForSelector('.addcart, .soldout', { timeout: 5000 });

        const html = await page.content();

        await browser.close();
        return html;
    } catch (err) {
        console.error('fetchHtml error:', err.message);
        throw err;
    }
}

/**
 * Check Mandarake product page for stock:
 * - main button (id=cartButton) with text カートに入れる or class addcart
 * - other stores in section .other_itemlist .block checking .addcart / .soldout
 *
 * Returns:
 *  { url, inStock (bool), mainAdd (bool), stores: [ { title, shop, price, hasAdd } ] }
 */
async function checkMandarake(url, opts = {}) {
    const html = await fetchHtml(url, opts);
    const $ = cheerio.load(html);

    const isInMainInStock = $('#mypagelist_form .addcart').length > 0;
    const parentShopName = $('.content_head .shop p').text().trim();
    const itemName = $('.content_head .subject h1').text().trim();

    // Same Item in Other Store(s)
    const sameItemInOtherStores = [];
    $('.other_itemlist .block').each((i, el) => {
        const block = $(el);
        const shop = block.find('.shop p').text().trim();
        const price = block.find('.price').text().trim();
        const hasAdd = block.find('.addcart').length > 0;
        const soldOut = block.find('.soldout').length > 0;

        sameItemInOtherStores.push({ shop, price, hasAdd, soldOut });
    });

    const isInStock = isInMainInStock || sameItemInOtherStores.some(s => s.hasAdd && !s.soldOut);

    return { url, isInStock, isInMainInStock, sameItemInOtherStores, itemName, parentShopName };
}

module.exports = { checkMandarake };
