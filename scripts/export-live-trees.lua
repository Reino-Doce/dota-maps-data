-- Run only on the importer's local, owned server.
local trees = Entities:FindAllByClassname("ent_dota_tree")
if #trees == 0 then return end
print("[LIVE_TREES_BEGIN]")
for _, tree in ipairs(trees) do
    local p = tree:GetAbsOrigin()
    local id = GetTreeIdForEntityIndex(tree:GetEntityIndex())
    print(string.format("[LIVE_TREE][%d,%.9g,%.9g,%.9g]", id, p.x, p.y, p.z))
end
print("[LIVE_TREES_END]")
