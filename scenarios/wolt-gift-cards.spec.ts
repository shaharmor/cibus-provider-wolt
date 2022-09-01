import { test, ElementHandle } from '@playwright/test';
import pMap from 'p-map';
import delay from 'delay';

// TODO: accept arguments from cli
const CIBUS_USER = '';
const CIBUS_PASS = '';
const CIBUS_COMPANY = '';
const GOOGLE_EMAIL = '';
const GOOGLE_PASS = '';
const WOLT_MIN_BUDGET = 20;

function calcBudgetDistribution(arr, sum) {
  function calcRecursive(arr, n, v, sum) {
    if (sum === 0) {
      return [...v];
    }

    // crossed limit
    if (sum < 0) {
      return null;
    }

    // no more items
    if (n === 0) {
      return null;
    }

    // calc without next item
    let x = calcRecursive(arr, n - 1, v, sum);

    // add next item
    v.push(arr[n - 1]);

    // calc with next item
    let y = calcRecursive(arr, n, v, sum - arr[n - 1]);
    v.pop();

    if (!x || x.length === 0) {
      return y;
    }
    if (!y || y.length === 0) {
      return x;
    }
    return x.length < y.length ? x : y;
  }

  return calcRecursive(arr, arr.length, [], sum);
}

test('spend cibus budget on wolf gift cards', async ({ page, browser }) => {
  test.setTimeout(10000000);
  console.log('Cibus: Loading site');
  await page.goto('https://www.mysodexo.co.il/');

  console.log('Cibus: Logging in');
  await page.locator(`#txtUsr`).fill(CIBUS_USER);
  await page.locator(`#txtPas`).fill(CIBUS_PASS);
  await page.locator(`#txtCmp`).fill(CIBUS_COMPANY);
  await page.locator('#btnLogin').click();

  console.log('Cibus: Reading available budget');
  const response = await page.waitForResponse('**/new_ajax_service.aspx?getBdgt=1');
  const body = await response.body();
  const actualBudget = Number(body);
  console.log(`Cibus: Available budget: ${actualBudget}`);

  if (actualBudget < WOLT_MIN_BUDGET) {
    console.log(`Cibus: budget of ${actualBudget} is lower than wolt's smallest gift card of ${WOLT_MIN_BUDGET}`);
    return;
  }

  // login to wolt
  console.log('Wolt: Loading site');
  const woltPage = await browser.newPage();
  await woltPage.goto('https://authentication.wolt.com/v1/wauth2/consumer-google?audience=wolt-com');

  let currentTitle = await woltPage.title();

  // wolt redirected us to the Google login page
  if (!currentTitle.endsWith('Wolt')) {
    console.log('Wolt: Logging in');
    await woltPage.waitForSelector('input[type="email"]');
    await woltPage.type('input[type="email"]', GOOGLE_EMAIL, { delay: 50 });
    await woltPage.locator('#identifierNext button').click();
    await delay(1000);
    await woltPage.waitForSelector('input[type="password"]');
    await woltPage.type('input[type="password"]', GOOGLE_PASS, { delay: 50 });
    await woltPage.locator('#passwordNext button').click();
    await delay(1000);
    // TODO: maybe bypass 2fa by using a dedicated Google app
    console.log('Wolt: Waiting for 2FA');
    await new Promise((resolve) => setTimeout(resolve, 60000));
    currentTitle = await woltPage.title();
    if (!currentTitle.endsWith('Wolt')) {
      console.error('Wolt: Login failed');
      return;
    }
  }

  console.log('Wolt: Loading gift cards venue');
  await woltPage.goto('https://wolt.com/en/isr/rishon-lezion/venue/woltilgiftcards');

  // remove gdpr banner
  const banner = await woltPage.locator('div.ConsentsBannerOverlay');
  if (await banner.count()) {
    console.log('Wolt: Removing GDPR banner');
    await banner.locator('button[data-localization-key="gdpr-consents.banner.accept-button"]').click();
  }

  // calc the least amount of gift cards
  console.log('Wolt: Reading available gift cards');
  await woltPage.waitForSelector('data-test-id=menu-item-presentational.price', { timeout: 10000 });
  const giftCardsElements = await woltPage.locator('data-test-id=menu-item-presentational.price').elementHandles();
  const giftCards: { el: ElementHandle, value: number }[] = [];
  for (let i = 0; i < giftCardsElements.length; i++) {
    const item = giftCardsElements[i];
    giftCards.push({
      el: item,
      value: Number((await item.textContent()).replace(/\D/g, '')) / 100
    });
  }

  const giftCardsPrices = giftCards.map((g) => g.value);
  const cappedBudget = actualBudget - (actualBudget % 5);
  console.log(`Wolt: Capping budget to ${cappedBudget}`);
  const giftCardsDistribution = calcBudgetDistribution(giftCardsPrices, cappedBudget);
  console.log(`Wolt: Gift cards distribution: ${cappedBudget} = ${giftCardsDistribution}`);

  // for each gift card chosen, add to cart
  await pMap(giftCardsDistribution, async (currGiftCardValue) => {
    const currGiftCard = giftCards.find((g) => g.value === currGiftCardValue);
    // open gift card modal
    await currGiftCard.el.click();
    await delay(1000);
    const modal = await woltPage.locator('data-test-id=product-modal');
    // if "Add to order" -> add
    if (await modal.locator('span[data-localization-key="product-modal.submit.add"]').count() === 1) {
      console.log(`Wolt: Adding new gift card ${currGiftCardValue} to cart`);
      await modal.locator('data-test-id=product-modal.submit').click();
    }
    // if "Update order -> increment + add
    else if (await modal.locator('span[data-localization-key="product-modal.submit.update"]').count() === 1) {
      console.log(`Wolt: Updating existing gift card ${currGiftCardValue} in cart`);
      await modal.locator('data-test-id=product-modal.quantity.increment').click();
      await modal.locator('data-test-id=product-modal.submit').click();
    } else {
      console.error('UNKNOWN CART STATE');
      process.exit();
    }
  });

  console.log('Wolt: Loading checkout page');
  await woltPage.locator('data-test-id=CartViewButton').first().click();
  await woltPage.locator('data-test-id=CartViewNextStepButton').click();
  await delay(1000);
  console.log('Wolt: Choosing Cibus payment method');
  await woltPage.locator('data-test-id=PaymentMethods.SelectedPaymentMethod').click();
  await woltPage.locator('data-test-id=PaymentMethodItem', { hasText: /Cibus/ }).click();
  await delay(3000);
  console.log('Wolt: Ordering');
  await woltPage.locator('data-test-id=SendOrderButton').click();
  await delay(3000);
  console.log('Wolt: Logging in with Cibus');
  const cibusFrame = woltPage.frameLocator('iframe[name="cibus-frame"]');
  await cibusFrame.locator('#txtUserName').fill(CIBUS_USER);
  await cibusFrame.locator('#txtPassword').fill(CIBUS_PASS);
  await cibusFrame.locator('#txtCompany').fill(CIBUS_COMPANY);
  await cibusFrame.locator('#btnSubmit').click();
  await cibusFrame.locator('#btnPay').click();
  await woltPage.waitForNavigation();
  console.log('Wolt: Order complete');
});
