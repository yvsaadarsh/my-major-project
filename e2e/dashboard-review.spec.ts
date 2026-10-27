import { test, expect } from '@playwright/test';
import { apiFetch, storageStatePath } from './fixtures';
test.use({storageState:storageStatePath('ADMIN')});

test('dashboard project links select the named project and survive refresh', async ({page}) => {
  await page.goto('/dashboard');
  const {json}=await apiFetch(page,'GET','/api/v1/projects');
  const projects=(json as {projects:{id:string;name:string}[]}).projects;
  const project=projects[1];
  const link=page.locator('a').filter({has:page.getByText(project.name,{exact:true})});
  await expect(link).toHaveAttribute('href',`/projects?projectId=${project.id}`);
  await link.click();
  await expect(page.getByRole('button',{name:project.name,exact:true})).toHaveAttribute('aria-pressed','true');
  await page.reload();
  await expect(page.getByRole('button',{name:project.name,exact:true})).toHaveAttribute('aria-pressed','true');
});

test('dashboard failure offers retry without presenting fabricated zero metrics', async ({page})=>{
  let fail=true;
  await page.route('**/api/v1/dashboard/summary',route=> fail ? route.fulfill({status:500,json:{error:{message:'Review outage'}}}) : route.continue());
  await page.goto('/dashboard');
  await expect(page.getByText('Review outage')).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry dashboard'})).toBeVisible();
  expect((await apiFetch(page,'POST','/api/v1/projects',{name:`Completed review ${Date.now()}`,status:'COMPLETED'})).status).toBe(201);
  fail=false;await page.getByRole('button',{name:'Retry dashboard'}).click();
  await expect(page.getByText('Review outage')).toHaveCount(0);
  const {json}=await apiFetch(page,'GET','/api/v1/dashboard/summary');
  const count=(json as {summary:{activeProjectCount:number}}).summary.activeProjectCount;
  const list=(await apiFetch(page,'GET','/api/v1/projects')).json as {projects:{status:string}[]};
  expect(count).toBe(list.projects.filter(p=>p.status==='ACTIVE').length);
  await expect(page.locator('section').filter({has:page.getByText('Active projects',{exact:true})}).getByText(String(count),{exact:true})).toBeVisible();
});

test('dashboard counts update after task completion and desktop/mobile fit',async({page})=>{
  await page.goto('/dashboard');
  const before=(await apiFetch(page,'GET','/api/v1/dashboard/summary')).json as {summary:{taskCount:number;completedTaskCount:number}};
  const projects=(await apiFetch(page,'GET','/api/v1/projects')).json as {projects:{id:string}[]};
  const created=await apiFetch(page,'POST',`/api/v1/projects/${projects.projects[0].id}/tasks`,{title:'Dashboard review task',status:'TODO',priority:'HIGH'});
  const id=(created.json as {task:{id:string}}).task.id;
  await apiFetch(page,'PATCH',`/api/v1/tasks/${id}`,{status:'DONE'});
  await page.reload();
  await expect(page.locator('section').filter({has:page.getByText('Done tasks',{exact:true})}).getByText(String(before.summary.completedTaskCount+1),{exact:true})).toBeVisible();
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await expect(page.getByRole('heading',{name:'Project pulse'})).toBeVisible();
    if(width===390){
      await expect(page.getByRole('navigation',{name:'Mobile navigation'})).toBeVisible();
      await expect(page.getByRole('navigation',{name:'Mobile navigation'}).getByRole('link',{name:'Projects',exact:true})).toBeVisible();
    }
    await page.getByRole('heading',{name:'Project pulse'}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`/workspace/.onboarding/results/dashboard-${width}.png`,fullPage:true});
    if(width===390){
      await page.getByRole('navigation',{name:'Mobile navigation'}).getByRole('link',{name:'Projects',exact:true}).click();
      await expect(page).toHaveURL(/\/projects$/);
      await expect(page.getByRole('textbox',{name:'Task title',exact:true})).toBeVisible();
    }
  }
});

test('AI Edit first preserves every parsed task field through a real task write (mocked model)',async({page})=>{
  const title=`Parsed review ${Date.now()}`;
  await page.route('**/api/v1/ai/parse-task',route=>route.fulfill({json:{title,description:'Keep the reviewed description',priority:'HIGH',dueDate:'2026-11-06',notes:''}}));
  await page.goto('/dashboard');
  await page.getByRole('button',{name:'Open command center'}).click();
  await page.getByPlaceholder(/Search tasks|Search anything|Search or type/i).fill('Create task with AI');
  await page.getByText('Create task with AI',{exact:true}).click();
  await page.getByPlaceholder('Describe the task…  e.g. “Ship the billing hotfix by Friday, high priority, needs review from Sam”').fill('Prepare the review');
  await page.getByRole('button',{name:'Parse',exact:true}).click();
  await page.getByRole('button',{name:'Edit first',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Task title',exact:true})).toHaveValue(title);
  await expect(page.getByRole('textbox',{name:'Task description'})).toHaveValue('Keep the reviewed description');
  await expect(page.getByRole('combobox',{name:'Task priority'})).toHaveValue('HIGH');
  await expect(page.getByLabel('Task due date')).toHaveValue('2026-11-06');
  const response=page.waitForResponse(r=>r.url().includes('/tasks')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Add task',exact:true}).click();
  const saved=await response;expect(saved.status()).toBe(201);
  const {task}=await saved.json();
  expect(task).toMatchObject({title,description:'Keep the reviewed description',priority:'HIGH'});
  expect(task.dueDate).toContain('2026-11-06');
});

test('AI stream failures stay visible and Refresh retries (mocked provider)',async({page})=>{
  await page.goto('/dashboard');
  const list=(await apiFetch(page,'GET','/api/v1/projects')).json as {projects:{id:string}[]};
  const id=list.projects[0].id;let fail=true;
  for(const feature of ['narrative','forecast'])await page.route(`**/api/v1/intelligence/projects/${id}/${feature}`,route=>route.fulfill(fail?{status:502,json:{error:'upstream'}}:{contentType:'text/plain',body:'Complete test narrative. Metrics remain authoritative.'}));
  await page.goto(`/intelligence/${id}`);
  await expect(page.getByText('AI brief could not complete. Use Refresh to retry.')).toBeVisible();
  await expect(page.getByText('AI forecast could not complete. Use Refresh to retry.')).toBeVisible();
  fail=false;await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByText('AI brief could not complete. Use Refresh to retry.')).toHaveCount(0);
  await expect(page.getByText('Complete test narrative. Metrics remain authoritative.')).toHaveCount(2);
});

test('comments, audit activity, and notification read state persist',async({page})=>{
  await page.goto('/projects');
  const list=(await apiFetch(page,'GET','/api/v1/projects')).json as {projects:{id:string}[]};
  const created=await apiFetch(page,'POST',`/api/v1/projects/${list.projects[0].id}/tasks`,{title:'Collaboration review',priority:'HIGH',status:'TODO'});
  const id=(created.json as {task:{id:string}}).task.id;
  const body=`Review comment ${Date.now()}`;
  expect((await apiFetch(page,'POST',`/api/v1/tasks/${id}/comments`,{body})).status).toBe(201);
  await page.goto(`/tasks/${id}`);await expect(page.getByText(body,{exact:true})).toBeVisible();
  const activity=await apiFetch(page,'GET',`/api/v1/tasks/${id}/activity`);
  expect(JSON.stringify(activity.json)).toContain('task.comment_created');
  expect((await apiFetch(page,'POST','/api/v1/automations/run',{})).status).toBe(200);
  const feed=(await apiFetch(page,'GET','/api/v1/notifications')).json as {notifications:unknown[]};
  expect(feed.notifications.length).toBeGreaterThan(0);
  expect((await apiFetch(page,'POST','/api/v1/notifications/read-all',{})).status).toBe(200);
  await page.goto('/notifications');
  const after=(await apiFetch(page,'GET','/api/v1/notifications')).json as {unreadCount:number};
  expect(after.unreadCount).toBe(0);
});

test('sign in through the browser opens the real dashboard',async({browser})=>{
  const context=await browser.newContext({storageState:{cookies:[],origins:[]}});
  const page=await context.newPage();
  try{
    await page.goto('http://127.0.0.1:3123/');
    await page.getByRole('tab',{name:'Sign in',exact:true}).click();
    await page.locator('input[type=email]').fill('ada@northwind.test');
    await page.locator('input[type=password]').fill('Password123!');
    await page.getByRole('button',{name:'Open workspace',exact:true}).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading',{name:'Project pulse'})).toBeVisible();
  }finally{await context.close();}
});

test('retrospective errors offer a working retry (mocked provider)',async({page})=>{
  await page.goto('/projects');
  const created=await apiFetch(page,'POST','/api/v1/projects',{name:`Retrospective retry ${Date.now()}`});
  const id=(created.json as {project:{id:string}}).project.id;
  expect((await apiFetch(page,'POST',`/api/v1/projects/${id}/milestones`,{name:'Closed review milestone',dueDate:'2026-10-20T00:00:00.000Z',status:'DONE'})).status).toBe(201);
  let failed=true;
  await page.route('**/retrospective',route=>route.fulfill(failed?{status:503,json:{error:'temporarily unavailable'}}:{contentType:'text/plain',body:'The completed milestone has a complete retrospective.'}));
  await page.goto(`/projects?projectId=${id}`);
  await page.getByRole('button',{name:'View Retrospective'}).click();
  await expect(page.getByRole('button',{name:'Retry retrospective'})).toBeVisible();
  failed=false;await page.getByRole('button',{name:'Retry retrospective'}).click();
  await expect(page.getByText('The completed milestone has a complete retrospective.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry retrospective'})).toHaveCount(0);
});

test('dashboard notification menu remains clickable above cards',async({page})=>{
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    await page.goto('/dashboard');
    await page.getByRole('button',{name:/^Notifications/}).click();
    const box=await page.getByRole('menu').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x+box!.width).toBeLessThanOrEqual(width);
    await page.getByRole('link',{name:'View all notifications',exact:true}).click();
    await expect(page).toHaveURL(/\/notifications$/);
  }
});
