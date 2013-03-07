/*!
 * VisualEditor user interface ContentDialog class.
 *
 * @copyright 2011-2013 VisualEditor Team and others; see AUTHORS.txt
 * @license The MIT License (MIT); see LICENSE.txt
 */

/**
 * Document dialog.
 *
 * @class
 * @abstract
 * @extends ve.ui.Dialog
 *
 * @constructor
 * @param {ve.ui.Surface} surface
 */
ve.ui.ContentDialog = function VeUiContentDialog( surface ) {
	// Parent constructor
	ve.ui.Dialog.call( this, surface );
};

/* Inheritance */

ve.inheritClass( ve.ui.ContentDialog, ve.ui.Dialog );

/* Static Properties */

/**
 * Localized message for dialog title.
 *
 * @static
 * @property
 * @type {string}
 */
ve.ui.ContentDialog.static.dialogTitleMessage = 'visualeditor-dialog-content-title';

/* Methods */

