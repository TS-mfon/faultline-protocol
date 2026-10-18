import {test,expect} from '@playwright/test';
test('replay graph and evidence remain usable when live configuration is unavailable',async({page})=>{
 await page.route('**/api/v1/workflows',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'NOT_CONFIGURED',message:'Live service is not configured'}})}));
 await page.goto('/');await expect(page.getByText('Read-only replay',{exact:true}).first()).toBeVisible();
 await expect(page.getByRole('heading',{name:/Mandate graph/})).toBeVisible();
 await page.getByRole('button',{name:/Review and contain.*Inspect details/}).click();
 await expect(page.getByText(/independent.*check|Independently check/).first()).toBeVisible();
 await page.getByRole('button',{name:'List',exact:true}).click();
 await expect(page.getByRole('button',{name:/Publish approved result.*Depends on/})).toBeVisible();
 await expect(page.getByText('No live transactions',{exact:false}).first()).toBeVisible();
 await expect(page.locator('body')).not.toContainText('Live payment confirmed');
 await page.screenshot({path:test.info().outputPath('investigation.png'),fullPage:true});
});
test('template chooser keeps replay and wallet operations explicit',async({page})=>{
 await page.goto('/');
 const start=page.getByRole('button',{name:/New workflow|Create workflow|Start workflow/}).first();await start.click();
 await expect(page.getByRole('heading',{name:'Start with a clear commitment'})).toBeVisible();
 await expect(page.getByText('3 mandates · 2 dependencies').first()).toBeVisible();
 await page.getByRole('button',{name:'Configure workflow',exact:true}).click();
 await expect(page.getByRole('button',{name:'Review terms',exact:true})).toBeDisabled();
});
