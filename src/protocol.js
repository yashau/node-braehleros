'use strict';

const CMD = Object.freeze({
  INITIALIZE:            1,
  CONFERENCE_STATE:      2,
  SPEAKER_ADDED:         3,
  SPEAKER_REMOVED:       4,
  REQUEST_ADDED:         5,
  REQUEST_REMOVED:       6,
  DELEGATE_LOGIN:        11,
  INTERVENTION_ADDED:    46,
  INTERVENTION_REMOVED:  47,
  PREV_SPEAKER_ADDED:    50,
  PREV_SPEAKER_REMOVED:  51,
  CLIENT_IDENTIFICATION: 58,
  BEGIN_INITIALIZE:      66,
  END_INITIALIZE:        67,
});

const CLIENT_TYPE = Object.freeze({
  VIEWER: 1,
  CLIENT: 2,
});

module.exports = { CMD, CLIENT_TYPE };
