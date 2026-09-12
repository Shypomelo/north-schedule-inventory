# Personnel and workspace architecture

Personnel configuration has four independent axes:

- `team_members.role` is the system permission boundary. Its values remain `ADMIN`, `ENGINEER`, and `VIEWER`; business departments must not be added to this enum.
- `positions` plus `member_positions` describe a person's business position. UI assignment is data-driven from active rows. The current schema has no immutable position code, so engineering shortcuts resolve the normalized active position name `工程` in one shared resolver.
- `work_groups` plus `member_work_groups` control Schedule and Team Todo scope. A selected default must belong to the selected membership set.
- `dashboard_views` plus `member_dashboard_views` control Dashboard perspectives. A selected default must belong to the selected view set. Administrators may access every active view even without assignment.

The admin personnel modal persists all four axes through `update_member_workspace_profile`. The function is `SECURITY INVOKER`, checks the administrator boundary, validates the complete requested profile, and replaces the related memberships in one PostgreSQL transaction. Existing RLS policies and the permanent-owner trigger remain authoritative.

`team_members.category` is compatibility-only. It remains in the database for historical Schedule participant resolution and adapter compatibility, but it is not the source for Sidebar engineering people or personal project filters. `projects.responsible_member_name` likewise remains an adapter compatibility field; canonical personal project filtering uses `project_position_assignments`.

## Future business workspace

A future business department should add data rows such as a business position, work group, and dashboard view, then assign memberships. It should not add a `BUSINESS` system role. This keeps authorization separate from organization structure and lets the UI render new positions and perspectives without branching on new permission values.
