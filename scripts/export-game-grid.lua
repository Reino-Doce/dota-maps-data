-- Copy to scripts/vscripts/interactive_map_grid_export.lua in the game.
-- capture-game-grid.mjs loads it through the local dedicated server console.
-- Exports engine ground heights and world-space entities for the full GNV grid.
function ExportInteractiveMapGrid()
    -- A console connection and a Lua VM can exist before the map entities.
    -- Returning without BEGIN makes the caller retry after loading completes.
    local trees = Entities:FindAllByClassname("ent_dota_tree")
    local pools = Entities:FindAllByClassname("npc_dota_lotus_pool")
    if #trees == 0 or #pools == 0 then return end
    local options = INTERACTIVE_MAP_EXPORT or {}
    local width, height, cell = options.width or 320, options.height or 328, options.cellSize or 64
    local minX, minY = options.minX or -10240, options.minY or -10752
    print('[MAP_GRID_BEGIN]' .. string.format(
        '{"width":%d,"height":%d,"cellSize":%d,"origin":[%d,%d],"map":"%s"}',
        width, height, cell, minX, minY, GetMapName()))
    for y = 0, height - 1 do
        local row = {}
        for x = 0, width - 1 do
            local z = GetGroundHeight(Vector(minX + (x + 0.5) * cell, minY + (y + 0.5) * cell, 0), nil)
            row[#row + 1] = string.format("%.9g", z)
        end
        print('[MAP_GRID_HEIGHT]' .. "[" .. table.concat(row, ",") .. "]")
    end
    for _, entity in ipairs(trees) do
        local p = entity:GetAbsOrigin()
        print('[MAP_GRID_TREE]' .. string.format("[%.9g,%.9g,%.9g]", p.x, p.y, p.z))
    end
    -- NPC movement hulls do not describe the visible structure. Retain the
    -- model and its placement so the importer can project its actual meshes.
    for _, class in ipairs({"npc_dota_lotus_pool", "npc_dota_unit_twin_gate", "npc_dota_watch_tower"}) do
        for _, entity in ipairs(Entities:FindAllByClassname(class)) do
            local p, a = entity:GetAbsOrigin(), entity:GetAngles()
            local lo, hi = entity:GetBoundingMins(), entity:GetBoundingMaxs()
            print('[MAP_GRID_ENTITY]' .. string.format(
                '{"classname":%q,"name":%q,"model":%q,"modelScale":%.9g,"angles":[%.9g,%.9g,%.9g],"origin":[%.9g,%.9g,%.9g],"hullRadius":%.9g,"bounds":[[%.9g,%.9g,%.9g],[%.9g,%.9g,%.9g]]}',
                class, entity:GetName(), entity:GetModelName(), entity:GetModelScale(), a.x, a.y, a.z,
                p.x, p.y, p.z, entity:GetHullRadius(), lo.x, lo.y, lo.z, hi.x, hi.y, hi.z))
        end
    end
    -- Both locations exist even when the Tormentor is absent. Trace the world
    -- beneath each location: GetGroundHeight alone bridges over the pit floor.
    for _, entity in ipairs(Entities:FindAllByClassname("info_player_start_dota")) do
        if string.match(entity:GetName(), "^miniboss_location_%d+$") then
            local p = entity:GetAbsOrigin()
            local step, size = 8, 128
            local x0, y0 = math.floor(p.x / step) * step - 512, math.floor(p.y / step) * step - 512
            local rows = {}
            for y = 0, size - 1 do
                local spans, first = {}, nil
                for x = 0, size do
                    local blocked = false
                    if x < size then
                        local v = Vector(x0 + (x + 0.5) * step, y0 + (y + 0.5) * step, 0)
                        local ground = GetGroundHeight(v, nil)
                        local trace = { startpos = Vector(v.x, v.y, p.z + 1024), endpos = Vector(v.x, v.y, p.z - 2048), mask = 33636363 }
                        TraceLine(trace)
                        blocked = trace.hit and trace.pos.z < ground - 32
                    end
                    if blocked and first == nil then first = x end
                    if not blocked and first ~= nil then
                        spans[#spans + 1], spans[#spans + 2], first = first, x, nil
                    end
                end
                rows[#rows + 1] = "[" .. table.concat(spans, ",") .. "]"
            end
            print('[MAP_GRID_PIT]' .. string.format(
                '{"name":%q,"center":[%.9g,%.9g],"origin":[%d,%d],"cellSize":%d,"width":%d,"height":%d,"blockedRows":[%s]}',
                entity:GetName(), p.x, p.y, x0, y0, step, size, size, table.concat(rows, ",")))
        end
    end
    print("[MAP_GRID_EXPORT_COMPLETE]")
    -- Attaching to a terrain demo must never close the user's game. The caller
    -- owns the lifetime of any dedicated server it starts for a scan.
end

ExportInteractiveMapGrid()
