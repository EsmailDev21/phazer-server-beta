-- Step 1.7 load dataset. Run on a database that has ALL migrations applied and is otherwise empty.
-- ~760k tasks: workspace W1 (the one measured) has 460k over 40 projects + 60k Inbox tasks,
-- three more workspaces of 100k add realistic noise. Deterministic ids so the harness can address them.
SET synchronous_commit = off;
INSERT INTO users(id,email,name,username) SELECT 'u'||g, 'u'||g||'@x.io', 'User '||g, 'user'||g FROM generate_series(1,21) g;
INSERT INTO accounts(id,type) VALUES ('a1','ORGANIZATION');
INSERT INTO workspaces(id,account_id,key,name) VALUES ('w1','a1','ENG','W1'),('w2','a1','BBB','W2'),('w3','a1','CCC','W3'),('w4','a1','DDD','W4');

-- projects: 40 in w1, 10 in each other workspace
INSERT INTO projects(id,workspace_id,name,created_by_id)
SELECT 'p_w1_'||g,'w1','P'||g,'u1' FROM generate_series(1,40) g;
INSERT INTO projects(id,workspace_id,name,created_by_id)
SELECT 'p_'||w||'_'||g,w,'P'||g,'u1' FROM unnest(ARRAY['w2','w3','w4']) w, generate_series(1,10) g;

-- 4 default statuses per project, deterministic ids
INSERT INTO workflow_statuses(id,project_id,name,name_key,color,position,category,is_default,updated_at)
SELECT 'wfs_'||p.id||'_'||v.cat, p.id, v.name, lower(v.name), '#94A3B8', v.pos, v.cat::task_status, true, now()
FROM projects p CROSS JOIN (VALUES ('To Do',0,'TODO'),('In Progress',1,'IN_PROGRESS'),('Blocked',2,'BLOCKED'),('Done',3,'DONE')) v(name,pos,cat);
UPDATE projects p SET default_workflow_status_id = 'wfs_'||p.id||'_TODO';

-- issue types + iterations (w1)
INSERT INTO issue_types(id,workspace_id,name,name_key,updated_at) SELECT 'it_w1_'||g,'w1','Type'||g,'type'||g,now() FROM generate_series(1,5) g;
INSERT INTO iterations(id,workspace_id,kind,name,state,updated_at) SELECT 'iter_w1_'||g,'w1','SPRINT','Sprint '||g,'ACTIVE',now() FROM generate_series(1,20) g;

-- tasks. w1: numbers 1..460000; i<=400000 -> project ((i-1)%40)+1, else Inbox (project NULL).
INSERT INTO tasks(id,workspace_id,project_id,number,title,status,priority,created_by_id,is_archived,created_at,updated_at,
                  parent_id,workflow_status_id,issue_type_id,iteration_id)
SELECT 't_w1_'||i, 'w1',
       CASE WHEN i<=400000 THEN 'p_w1_'||(((i-1)%40)+1) END,
       i, 'Task '||i, s.st::task_status, 'MEDIUM', 'u1',
       (i%20=0),
       now() - (random()*730 || ' days')::interval, now(),
       CASE WHEN i%10=0 AND i>40 AND i<=400000 THEN 't_w1_'||(i-40) END,
       CASE WHEN i<=400000 THEN 'wfs_p_w1_'||(((i-1)%40)+1)||'_'||s.st END,
       CASE WHEN i%5=0 THEN 'it_w1_'||((i%5)+1) END,
       CASE WHEN i%10=1 THEN 'iter_w1_'||((i%20)+1) END
FROM generate_series(1,460000) i,
     LATERAL (SELECT CASE WHEN i%100<40 THEN 'TODO' WHEN i%100<55 THEN 'IN_PROGRESS' WHEN i%100<60 THEN 'BLOCKED' ELSE 'DONE' END AS st) s;

INSERT INTO tasks(id,workspace_id,project_id,number,title,status,priority,created_by_id,is_archived,created_at,updated_at,workflow_status_id)
SELECT 't_'||w||'_'||i, w, 'p_'||w||'_'||(((i-1)%10)+1), i, 'Task '||i, s.st::task_status, 'MEDIUM','u1',(i%20=0),
       now() - (random()*730 || ' days')::interval, now(),
       'wfs_p_'||w||'_'||(((i-1)%10)+1)||'_'||s.st
FROM unnest(ARRAY['w2','w3','w4']) w, generate_series(1,100000) i,
     LATERAL (SELECT CASE WHEN i%100<40 THEN 'TODO' WHEN i%100<55 THEN 'IN_PROGRESS' WHEN i%100<60 THEN 'BLOCKED' ELSE 'DONE' END AS st) s;

UPDATE workspaces SET next_task_number = 460001 WHERE id='w1';
UPDATE workspaces SET next_task_number = 100001 WHERE id IN ('w2','w3','w4');

-- ~30% of w1 tasks have one assignee among 20 users
INSERT INTO "_TaskAssignees"("A","B") SELECT 't_w1_'||i, 'u'||((i%20)+2) FROM generate_series(1,460000) i WHERE i%10 IN (2,5,8);

ANALYZE;
