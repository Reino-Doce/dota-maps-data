-- Run only on an isolated dedicated server. Sample real Eyes units on eight
-- empty teams so the engine, including Roshan blockers, owns the FOW rules.
if INTERACTIVE_EYES_SCAN_RUNNING then return end
local trees = Entities:FindAllByClassname('ent_dota_tree')
if #trees == 0 then return end
INTERACTIVE_EYES_SCAN_RUNNING = true
local units, viewers, abilities = {}, {}, {}
local size, offset, cellSize = 41, -1280, 64
local function cleanup()
    for _, unit in ipairs(viewers) do if not unit:IsNull() then UTIL_Remove(unit) end end
    for _, unit in ipairs(units) do if not unit:IsNull() then UTIL_Remove(unit) end end
end
local function failed(message)
    cleanup()
    print('[EYES_SCAN_ERROR]' .. tostring(message))
end
local ok, err = pcall(function()
    assert(PlayerResource:GetPlayerCount() == 0, 'Eyes export requires an empty dedicated server')
    GameRules:SetPreGameTime(3600)
    table.sort(trees, function(a, b)
        local p, q = a:GetAbsOrigin(), b:GetAbsOrigin()
        return p.y == q.y and p.x < q.x or p.y < q.y
    end)
    local first = INTERACTIVE_EYES_SCAN_FIRST or 1
    local last = math.min(#trees, first + (INTERACTIVE_EYES_SCAN_COUNT or #trees) - 1)
    assert(first >= 1 and first <= last, 'Invalid Eyes scan batch')
    print('[EYES_SCAN_BEGIN]' .. string.format('{"map":%q,"count":%d,"radius":800,"cellSize":%d,"size":%d,"offset":%d}', GetMapName(), last - first + 1, cellSize, size, offset))
    PrecacheUnitByNameAsync('npc_dota_hero_treant', function()
        local started, message = pcall(function()
            -- A zero sight radius does not disable all NPC vision effects:
            -- towers/fountains can reveal distant cells when an eye is nearby.
            -- Remove NPCs while preserving terrain, trees and FOW blockers.
            local entity = Entities:First()
            local ambient = {}
            while entity do
                if entity.SetDayTimeVisionRange then ambient[#ambient + 1] = entity end
                entity = Entities:Next(entity)
            end
            for _, unit in ipairs(ambient) do UTIL_Remove(unit) end
            for i = 1, 8 do
                local team = DOTA_TEAM_CUSTOM_1 + i - 1
                local hero = CreateUnitByName('npc_dota_hero_treant', Vector(-30000, -30000, 0), false, nil, nil, team)
                units[#units + 1] = hero
                hero:SetDayTimeVisionRange(0)
                hero:SetNightTimeVisionRange(0)
                hero:AddNewModifier(hero, nil, 'modifier_item_aghanims_shard', {})
                abilities[i] = hero:FindAbilityByName('treant_eyes_in_the_forest')
                abilities[i]:SetLevel(1)
            end
            local index, batch, phase, attempts = first, {}, 'clear', 0
            local function prepare()
                batch = {}
                for _, eye in ipairs(viewers) do UTIL_Remove(eye) end
                viewers = {}
                for i = 1, #units do
                    local tree = index + i - 1 <= last and trees[index + i - 1]
                    if tree then
                        local p = tree:GetAbsOrigin()
                        assert(p.x % 64 == 0 and p.y % 64 == 0, 'Tree origins no longer align to the FOW grid')
                        batch[i] = p
                    end
                end
                attempts = 0
            end
            local function visible(i, p, x, y)
                return IsLocationVisible(DOTA_TEAM_CUSTOM_1 + i - 1,
                    Vector(p.x + offset + x * cellSize + 32, p.y + offset + y * cellSize + 32, p.z))
            end
            local function isDark()
                -- Removal has a FOW fade. Wait for darkness before each cast,
                -- so nearby previous eyes and unrelated viewers cannot leak in.
                for i, p in ipairs(batch) do
                    for y = 0, size - 1 do
                        for x = 0, size - 1 do
                            if visible(i, p, x, y) then return false end
                        end
                    end
                end
                return true
            end
            local function cast()
                for i, p in ipairs(batch) do
                    local hero, tree = units[i], trees[index + i - 1]
                    -- Reproduce the ability on each real tree, including any
                    -- tree-boundary behavior of its newly created viewer.
                    hero:SetMana(hero:GetMaxMana())
                    abilities[i]:EndCooldown()
                    abilities[i]:SetCurrentAbilityCharges(2)
                    hero:SetCursorCastTarget(tree)
                    abilities[i]:CastAbility()
                    for _, eye in ipairs(Entities:FindAllByClassname('npc_dota_treant_eyes')) do
                        if eye:GetTeamNumber() == DOTA_TEAM_CUSTOM_1 + i - 1 then viewers[i] = eye end
                    end
                    assert(viewers[i] and viewers[i]:HasFlyingVision()
                        and viewers[i]:GetDayTimeVisionRange() == 800 and viewers[i]:GetNightTimeVisionRange() == 800,
                        'Ability did not create an Eyes unit with the expected vision')
                    local actual = viewers[i]:GetAbsOrigin()
                    assert(actual.x == p.x and actual.y == p.y, 'Eyes moved away from its host tree')
                end
            end
            units[1]:SetContextThink('interactive_eyes_scan', function()
                local success, problem = pcall(function()
                    if phase == 'clear' then prepare(); phase = 'cast'; return end
                    if phase == 'cast' then
                        attempts = attempts + 1
                        assert(attempts <= 8, 'Unrelated vision remained before an Eyes cast at tree ' .. index)
                        if isDark() then cast(); phase = 'sample' end
                        return
                    end
                    for i, p in ipairs(batch) do
                        local rows, litCells = {}, 0
                        for y = 0, size - 1 do
                            local spans, first = {}, nil
                            for x = 0, size do
                                local light = x < size and visible(i, p, x, y)
                                if light then litCells = litCells + 1 end
                                if light and first == nil then first = x end
                                if not light and first ~= nil then
                                    spans[#spans + 1], spans[#spans + 2], first = first, x, nil
                                end
                            end
                            rows[#rows + 1] = '[' .. table.concat(spans, ',') .. ']'
                        end
                        assert(litCells > 0, 'Eyes lost vision during export')
                        print('[EYES_SCAN_TREE]' .. string.format('{"x":%d,"y":%d,"rows":[%s]}', p.x, p.y, table.concat(rows, ',')))
                    end
                    index = index + #batch
                    if index <= last then prepare(); phase = 'cast' end
                end)
                if not success then failed(problem); return nil end
                if index > last then cleanup(); print('[EYES_SCAN_DONE]'); return nil end
                -- FOW refresh and old-viewer fade both settle before sampling.
                return 0.6
            end, 0.6)
        end)
        if not started then failed(message) end
    end, -1)
end)
if not ok then failed(err) end
