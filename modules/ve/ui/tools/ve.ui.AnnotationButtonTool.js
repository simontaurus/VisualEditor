/**
 * VisualEditor user interface AnnotationButtonTool class.
 *
 * @copyright 2011-2012 VisualEditor Team and others; see AUTHORS.txt
 * @license The MIT License (MIT); see LICENSE.txt
 */

/**
 * Creates an ve.ui.AnnotationButtonTool object.
 *
 * @abstract
 * @class
 * @constructor
 * @extends {ve.ui.ButtonTool}
 * @param {ve.ui.Toolbar} toolbar
 * @param {Object} annotation
 */
ve.ui.AnnotationButtonTool = function VeUiAnnotationButtonTool( toolbar, annotation ) {
	// Parent constructor
	ve.ui.ButtonTool.call( this, toolbar );

	// Properties
	this.annotation = annotation;
};

/* Inheritance */

ve.inheritClass( ve.ui.AnnotationButtonTool, ve.ui.ButtonTool );

/* Methods */

/**
 * Responds to the button being clicked.
 *
 * @method
 */
ve.ui.AnnotationButtonTool.prototype.onClick = function () {
	this.toolbar.getSurface().execute( 'annotation', 'toggle', this.annotation.name );
};

/**
 * Responds to the toolbar state being updated.
 *
 * @method
 * @param {ve.dm.Node[]} nodes List of nodes covered by the current selection
 * @param {ve.dm.AnnotationSet} full Annotations that cover all of the current selection
 * @param {ve.dm.AnnotationSet} partial Annotations that cover some or all of the current selection
 */
ve.ui.AnnotationButtonTool.prototype.onUpdateState = function ( nodes, full ) {
	this.setActive( full.hasAnnotationWithName( this.annotation.name ) );
};
