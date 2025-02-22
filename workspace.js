const { Clutter, GLib, GObject, Graphene, Meta, St } = imports.gi;

const Background = imports.ui.background;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const OverviewControls = imports.ui.overviewControls;
const Params = imports.misc.params;
const Util = imports.misc.util;
const { WindowPreview } = imports.ui.windowPreview;
var WINDOW_PREVIEW_MAXIMUM_SCALE = 0.95;
var WINDOW_REPOSITIONING_DELAY = 750;
var LAYOUT_SCALE_WEIGHT = 1;
var LAYOUT_SPACE_WEIGHT = 0.1;
const BACKGROUND_CORNER_RADIUS_PIXELS = 30;
const BACKGROUND_MARGIN = 12;

const Workspace = imports.ui.workspace;
const Self = imports.misc.extensionUtils.getCurrentExtension();
const _Util = Self.imports.util;
const animateAllocation = imports.ui.workspace.animateAllocation;

var staticBackgroundEnabled = false;
function staticBackgroundOverride() {
    if (!staticBackgroundEnabled) {
        global.vertical_overview.bgManagers = []
        for (var monitor of Main.layoutManager.monitors) {
            let bgManager = new Background.BackgroundManager({
                monitorIndex: monitor.index,
                container: Main.layoutManager.overviewGroup,
            })

            bgManager._fadeSignal = Main.overview._overview._controls._stateAdjustment.connect('notify::value', (v) => {
                bgManager.backgroundActor.opacity = Util.lerp(255, 127, Math.min(v.value));
            });

            global.vertical_overview.bgManagers.push(bgManager);
        }
        staticBackgroundEnabled = true;
    }
}

function staticBackgroundReset() {
    if (staticBackgroundEnabled) {
        for (var bg of global.vertical_overview.bgManagers) {
            Main.overview._overview._controls._stateAdjustment.disconnect(bg._fadeSignal);
            bg.destroy();
        }
        delete global.vertical_overview.bgManagers;
        staticBackgroundEnabled = false;
    }
}

var scalingWorkspaceBackgroundEnabled = false;
function scalingWorkspaceBackgroundOverride() {
    if (!scalingWorkspaceBackgroundEnabled) {
        global.vertical_overview.GSFunctions['Workspace'] = _Util.overrideProto(Workspace.Workspace.prototype, WorkspaceOverride);
        scalingWorkspaceBackgroundEnabled = true;
    }
}

function scalingWorkspaceBackgroundReset() {
    if (scalingWorkspaceBackgroundEnabled) {
        _Util.overrideProto(Workspace.Workspace.prototype, global.vertical_overview.GSFunctions['Workspace']);
        scalingWorkspaceBackgroundEnabled = false;
    }
}

WorkspaceOverride = {
    _init: function (metaWorkspace, monitorIndex, overviewAdjustment) {
        St.Widget.prototype._init.call(this, {
            style_class: 'window-picker',
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            layout_manager: new Clutter.BinLayout(),
        });

        const layoutManager = new Workspace.WorkspaceLayout(metaWorkspace, monitorIndex,
            overviewAdjustment);

        // Window previews
        this._container = new Clutter.Actor({
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._container.layout_manager = layoutManager;
        this.add_child(this._container);

        this.metaWorkspace = metaWorkspace;
        this._activeWorkspaceChangedId =
            this.metaWorkspace?.connect('notify::active', () => {
                layoutManager.syncOverlays();
            });

        this._overviewAdjustment = overviewAdjustment;
        this._overviewStateId = overviewAdjustment.connect('notify::value', () => {
            const overviewState = overviewAdjustment.value;

            // We want windows not to spill out when the overview is in
            // APP_GRID state, but HIDDEN and WINDOW_PICKER should allow
            // them to eventually draw outside the workspace.
            this._container.clip_to_allocation =
                overviewState > OverviewControls.ControlsState.WINDOW_PICKER;
        });

        this.monitorIndex = monitorIndex;
        this._monitor = Main.layoutManager.monitors[this.monitorIndex];

        if (monitorIndex != Main.layoutManager.primaryIndex)
            this.add_style_class_name('external-monitor');

        const clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', action => {
            // Switch to the workspace when not the active one, leave the
            // overview otherwise.
            if (action.get_button() === 1 || action.get_button() === 0) {
                const leaveOverview = this._shouldLeaveOverview();

                this.metaWorkspace?.activate(global.get_current_time());
                if (leaveOverview)
                    Main.overview.hide();
            }
        });
        this.bind_property('mapped', clickAction, 'enabled', GObject.BindingFlags.SYNC_CREATE);
        this._container.add_action(clickAction);

        this.connect('style-changed', this._onStyleChanged.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));

        const windows = global.get_window_actors().map(a => a.meta_window)
            .filter(this._isMyWindow, this);

        // Create clones for windows that should be
        // visible in the Overview
        this._windows = [];
        for (let i = 0; i < windows.length; i++) {
            if (this._isOverviewWindow(windows[i]))
                this._addWindowClone(windows[i]);
        }

        // Track window changes, but let the window tracker process them first
        if (this.metaWorkspace) {
            this._windowAddedId = this.metaWorkspace.connect_after(
                'window-added', this._windowAdded.bind(this));
            this._windowRemovedId = this.metaWorkspace.connect_after(
                'window-removed', this._windowRemoved.bind(this));
        }
        this._windowEnteredMonitorId = global.display.connect_after(
            'window-entered-monitor', this._windowEnteredMonitor.bind(this));
        this._windowLeftMonitorId = global.display.connect_after(
            'window-left-monitor', this._windowLeftMonitor.bind(this));
        this._layoutFrozenId = 0;

        // DND requires this to be set
        this._delegate = this;
    },

}
