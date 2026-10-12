import { DEFAULT_STUDY_EXAMPLE_LIMIT } from './constants.js';
import {
	createParentLock,
	isValidParentLockPin,
	isValidParentLockRecord,
	verifyParentLock
} from './parent-lock.js';
import {
	DEFAULT_SCHEDULING,
	fsrsDesiredRetention,
	fsrsMaximumIntervalDays,
	normalizeFsrsParametersText
} from './fsrs.js';

export function createSettingsUi(ctx) {
	const state = ctx.liveState();
	const $ = (...args) => ctx.$(...args);
	const realNow = (...args) => ctx.realNow(...args);
	const debugNowSeconds = (...args) => ctx.debugNowSeconds(...args);
	const formatDateTimeLocal = (...args) => ctx.formatDateTimeLocal(...args);
	const formatDebugTimeStatus = (...args) => ctx.formatDebugTimeStatus(...args);
	const saveState = (...args) => ctx.saveState(...args);
	const resetExpiredSession = (...args) => ctx.resetExpiredSession(...args);
	const renderProgress = (...args) => ctx.renderProgress(...args);
	const renderListEditor = (...args) => ctx.renderListEditor(...args);
	const refreshStudyAfterExternalChange = (...args) => ctx.refreshStudyAfterExternalChange(...args);
	let unlockedParentLockHash = null;
	let parentLockMessage = '';


	function parentLockRecord() {
		return isValidParentLockRecord(state.settings?.parentLock)
			? state.settings.parentLock
			: null;
	}

	function hasParentLock() {
		return !!parentLockRecord();
	}

	function parentControlsUnlocked() {
		const record = parentLockRecord();
		return !!record && unlockedParentLockHash === record.hash;
	}

	function parentSettingsLocked() {
		return hasParentLock() && !parentControlsUnlocked();
	}

	function clearParentLockPinInput() {
		const input = $('#parentLockPin');
		if (input) input.value = '';
	}

	function renderParentLock() {
		const locked = parentSettingsLocked();
		const configured = hasParentLock();
		const undoSetting = $('#settingShowUndoBlacklistButtons');
		const nextSetting = $('#settingShowNextCardButton');
		const manualGradingSetting = $('#settingShowManualGrading');
		if (undoSetting) undoSetting.disabled = locked;
		if (nextSetting) nextSetting.disabled = locked;
		if (manualGradingSetting) manualGradingSetting.disabled = locked;

		const primary = $('#btnParentLockPrimary');
		if (primary) {
			primary.textContent = configured && parentControlsUnlocked()
				? 'Unlocked'
				: configured
					? 'Unlock'
					: 'Set PIN';
			primary.disabled = configured && parentControlsUnlocked();
		}
		$('#btnParentLockNow')?.classList.toggle(
			'hidden',
			!configured || !parentControlsUnlocked()
		);
		$('#btnParentLockRemove')?.classList.toggle(
			'hidden',
			!configured || !parentControlsUnlocked()
		);

		let status = 'No PIN set. The protected Study controls can be changed freely.';
		if (configured && locked) {
			status = 'Locked. Enter the parent/teacher PIN to change Undo / Blacklist, Next card, or manual grading visibility.';
		} else if (configured) {
			status = 'Unlocked for this Settings visit. Leaving Settings will lock these controls again.';
		}
		ctx.setText('#parentLockStatus', parentLockMessage || status);
	}

	function updateProtectedStudySetting(key, value) {
		if (parentSettingsLocked()) {
			parentLockMessage = 'Enter the parent/teacher PIN before changing this setting.';
			renderSettings();
			return false;
		}
		parentLockMessage = '';
		updateSetting(key, value);
		return true;
	}

	async function setOrUnlockParentLock(pin) {
		const normalizedPin = String(pin || '').trim();
		if (!isValidParentLockPin(normalizedPin)) {
			parentLockMessage = 'PIN must contain 4 to 8 digits.';
			renderParentLock();
			return false;
		}
		try {
			if (!hasParentLock()) {
				state.settings.parentLock = await createParentLock(normalizedPin);
				unlockedParentLockHash = null;
				parentLockMessage = 'PIN set. Protected Study controls are now locked.';
				saveState();
			} else if (await verifyParentLock(normalizedPin, state.settings.parentLock)) {
				unlockedParentLockHash = state.settings.parentLock.hash;
				parentLockMessage = 'PIN accepted. Protected settings are unlocked until you leave Settings.';
			} else {
				parentLockMessage = 'Incorrect PIN.';
				renderParentLock();
				return false;
			}
			clearParentLockPinInput();
			renderSettings();
			return true;
		} catch (error) {
			parentLockMessage = error?.message || 'Could not update the parent/teacher lock.';
			renderParentLock();
			return false;
		}
	}

	function lockParentControls() {
		unlockedParentLockHash = null;
		parentLockMessage = '';
		clearParentLockPinInput();
		renderParentLock();
	}

	function removeParentLock() {
		if (!hasParentLock() || !parentControlsUnlocked()) return false;
		state.settings.parentLock = null;
		unlockedParentLockHash = null;
		parentLockMessage = 'Parent/teacher PIN removed.';
		clearParentLockPinInput();
		saveState();
		renderSettings();
		return true;
	}

	function positiveSetting(key, fallback, min = 0) {
		const value = Number(state.settings?.[key]);
		return Number.isFinite(value) ? Math.max(min, value) : fallback;
	}

	function integerSetting(key, fallback, min = 0) {
		const value = Number(state.settings?.[key]);
		return Number.isFinite(value)
			? Math.max(min, Math.floor(value))
			: fallback;
	}

	function sessionDuration() {
		return Math.max(
			60,
			Math.round(
				positiveSetting(
					'sessionHours',
					DEFAULT_SCHEDULING.sessionHours,
					0.02
				) * 3600
			)
		);
	}

	function learningStepInterval() {
		return Math.max(
			60,
			Math.round(
				positiveSetting(
					'learningStepMinutes',
					DEFAULT_SCHEDULING.learningStepMinutes,
					1
				) * 60
			)
		);
	}

	function relearningStepInterval() {
		return Math.max(
			60,
			Math.round(
				positiveSetting(
					'relearningStepMinutes',
					DEFAULT_SCHEDULING.relearningStepMinutes,
					1
				) * 60
			)
		);
	}

	function renderSettings() {
		if ($('#settingRevealOrder'))
			$('#settingRevealOrder').checked = !!state.settings.revealOrder;
		const showManualGrading = state.settings.showManualGrading !== false;
		if ($('#settingShowManualGrading'))
			$('#settingShowManualGrading').checked = showManualGrading;
		$('#manualGradePanel')?.classList.toggle(
			'hidden',
			!showManualGrading
		);
		const showUndoBlacklistButtons =
			state.settings.showUndoBlacklistButtons !== false;
		if ($('#settingShowUndoBlacklistButtons'))
			$('#settingShowUndoBlacklistButtons').checked =
				showUndoBlacklistButtons;
		$('#btnUndo')?.classList.toggle('hidden', !showUndoBlacklistButtons);
		$('#btnBlacklistCard')?.classList.toggle(
			'hidden',
			!showUndoBlacklistButtons
		);
		const showNextCardButton = state.settings.showNextCardButton !== false;
		if ($('#settingShowNextCardButton'))
			$('#settingShowNextCardButton').checked = showNextCardButton;
		$('#btnNext')?.classList.toggle('hidden', !showNextCardButton);
		renderParentLock();
		if ($('#settingSnapStrokes'))
			$('#settingSnapStrokes').checked = !!state.settings.snapStrokes;
		if ($('#settingStage2KeepUserStrokes'))
			$('#settingStage2KeepUserStrokes').checked =
				!!state.settings.stage2KeepUserStrokes;
		if ($('#settingStage3KeepUserStrokes'))
			$('#settingStage3KeepUserStrokes').checked =
				!!state.settings.stage3KeepUserStrokes;
		if ($('#settingMaxAdds'))
			$('#settingMaxAdds').value = state.settings.maxAdds;
		if ($('#settingMaxReviews'))
			$('#settingMaxReviews').value = state.settings.maxReviews;
		if ($('#settingStudyExampleLimit'))
			$('#settingStudyExampleLimit').value = integerSetting(
				'studyExampleLimit',
				DEFAULT_STUDY_EXAMPLE_LIMIT,
				1
			);
		if ($('#settingExamplesActiveListsOnly'))
			$('#settingExamplesActiveListsOnly').checked =
				!!state.settings.examplesActiveListsOnly;
		if ($('#settingSessionHours'))
			$('#settingSessionHours').value = positiveSetting(
				'sessionHours',
				DEFAULT_SCHEDULING.sessionHours,
				0.02
			);
		if ($('#settingDesiredRetention'))
			$('#settingDesiredRetention').value = fsrsDesiredRetention();
		if ($('#settingMaximumIntervalDays'))
			$('#settingMaximumIntervalDays').value = fsrsMaximumIntervalDays();
		if ($('#settingLearningStepMinutes'))
			$('#settingLearningStepMinutes').value = positiveSetting(
				'learningStepMinutes',
				DEFAULT_SCHEDULING.learningStepMinutes,
				1
			);
		if ($('#settingRelearningStepMinutes'))
			$('#settingRelearningStepMinutes').value = positiveSetting(
				'relearningStepMinutes',
				DEFAULT_SCHEDULING.relearningStepMinutes,
				1
			);
		if ($('#settingNewCardOrder'))
			$('#settingNewCardOrder').value =
				state.settings.newCardOrder || DEFAULT_SCHEDULING.newCardOrder;
		if ($('#settingReviewOrder'))
			$('#settingReviewOrder').value =
				state.settings.reviewOrder || DEFAULT_SCHEDULING.reviewOrder;
		if ($('#settingNewCardsIgnoreReviewLimit'))
			$('#settingNewCardsIgnoreReviewLimit').checked =
				!!state.settings.newCardsIgnoreReviewLimit;
		if ($('#settingFsrsParameters'))
			$('#settingFsrsParameters').value = normalizeFsrsParametersText(
				state.settings.fsrsParameters
			);
		if ($('#settingDebugNow'))
			$('#settingDebugNow').value = formatDateTimeLocal(debugNowSeconds());
		ctx.setText(
			'#debugTimeStatus',
			formatDebugTimeStatus(debugNowSeconds(), realNow())
		);
		ctx.renderFsrsOptimizationNotice?.();
	}

	function updateSetting(key, value) {
		state.settings[key] = value;
		saveState();
		resetExpiredSession();
		if (ctx.trainer) ctx.trainer.draw();
		renderProgress();
		if (ctx.selectedListId) renderListEditor();
	}

	function updateDebugNow(seconds) {
		state.settings.debugNow = Number.isFinite(Number(seconds))
			? Math.floor(Number(seconds))
			: null;
		saveState();
		resetExpiredSession();
		renderSettings();
		renderProgress();
		if (ctx.selectedListId) renderListEditor();
		refreshStudyAfterExternalChange();
	}

	return {
		sessionDuration,
		learningStepInterval,
		relearningStepInterval,
		renderSettings,
		updateSetting,
		updateProtectedStudySetting,
		setOrUnlockParentLock,
		lockParentControls,
		removeParentLock,
		updateDebugNow
	};
}
